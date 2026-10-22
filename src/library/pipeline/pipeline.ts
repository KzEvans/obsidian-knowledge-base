import { NORMALIZER_VERSION, derive } from '../../core/derive';
import type { Cropper } from '../../core/derive';
import type { EventBus } from '../../core/events';
import { nextTask, sha256Bytes } from '../../core/hash';
import type { Logger } from '../../core/log';
import { MAX_PDF_BYTES, MAX_PDF_PAGES, MINERU_OPTIONS, MinerUError } from '../../core/mineru';
import type { MinerUClient } from '../../core/mineru';
import type { PdfDocument } from '../../core/obsidian-internal';
import { CancelledError, RETRY_DELAYS_MS, TaskQueue, abortableSleep, attemptsOf, withRetry } from '../../core/queue';
import { FULL_TEXT_MODEL, PlaceholderMismatchError, QwenMtError, termsKey } from '../../core/qwen-mt';
import type { QwenMtClient } from '../../core/qwen-mt';
import { errorMessage } from '../../core/secrets';
import type { PipelineControl } from '../../core/services';
import type { StoreWriter } from '../../core/store';
import type { Manifest, ManifestSource, Stage, Term, TranslationFile } from '../../core/types';
import { documentSegments } from './segments';

/** Concurrency per resource (architecture §3.5); constants, not settings. */
export const MINERU_CONCURRENCY = 2;
export const QWEN_CONCURRENCY = 4;
/** Translations are written to disk after this many new segments. */
export const FLUSH_EVERY = 8;
/** A translation whose placeholders keep coming back wrong is recorded as failed after this many tries. */
export const PLACEHOLDER_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 5_000;
const POLL_DEADLINE_MS = 2 * 60 * 60 * 1000;
const TRANSLATE_TIMEOUT_MS = 60_000;

export interface PipelineDeps {
  store: StoreWriter;
  events: EventBus;
  mineru: MinerUClient;
  qwenMt: QwenMtClient;
  glossary(): readonly Term[];
  /** Vault-relative read; rejects when the file is gone. */
  readPdf(vaultPath: string): Promise<Uint8Array>;
  openPdf(bytes: Uint8Array): Promise<PdfDocument>;
  createCropper(pdf: PdfDocument): Cropper;
  /** Whether MinerU may be used for this paper without asking (the first-run backlog confirmation). */
  isApproved(manifest: Manifest): boolean;
  isInLibrary(vaultPath: string): boolean;
  log: Logger;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  retryDelays?: readonly number[];
  pollIntervalMs?: number;
  now?: () => Date;
}

export interface PaperStatus {
  manifest: Manifest;
  conflicts: string[];
  parse?: { done: number; total: number };
  translation?: { done: number; total: number; failed: number };
}

class SourceMissingError extends Error {
  constructor() { super('找不到这篇论文的 PDF，等它重新出现后继续。'); this.name = 'SourceMissingError'; }
}

class ConflictError extends Error {
  constructor(readonly files: string[]) { super(`iCloud 冲突副本：${files.join('、')}`); this.name = 'ConflictError'; }
}

const ACTIVE_STAGES: ReadonlySet<Stage> = new Set(['discovered', 'copied', 'uploading', 'parsing', 'normalizing', 'translating']);

/**
 * The parse/translate state machine (architecture §4.1). Every step reads its state from the store
 * and is idempotent, so a new instance resumes exactly where an interrupted one stopped.
 */
export class Pipeline implements PipelineControl {
  private readonly mineruQueue = new TaskQueue(MINERU_CONCURRENCY);
  private readonly normalizeQueue = new TaskQueue(1);
  private readonly qwenQueue = new TaskQueue(QWEN_CONCURRENCY);
  private readonly drivers = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly qwenKeys = new Map<string, Set<string>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly discovering = new Map<string, Promise<string | undefined>>();
  private readonly known = new Map<string, Manifest>();
  private readonly conflictFiles = new Map<string, string[]>();
  private readonly parseProgress = new Map<string, { done: number; total: number }>();
  private pausedState = false;
  private disposed = false;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly delays: readonly number[];

  constructor(private readonly deps: PipelineDeps) {
    this.sleep = deps.sleep ?? abortableSleep;
    this.delays = deps.retryDelays ?? RETRY_DELAYS_MS;
  }

  get paused(): boolean { return this.pausedState; }

  /** Load every manifest, bring outdated documents and translations back into the line, and resume. */
  async start(): Promise<void> {
    for (const sha of await this.deps.store.list()) {
      if (this.disposed) return;
      try {
        await this.inspect(sha);
      } catch (error) {
        this.deps.log.error(`读取论文状态失败：${sha.slice(0, 12)}`, error);
      }
      await nextTask();
    }
  }

  private async inspect(sha: string): Promise<void> {
    const store = this.deps.store as StoreWriter & { removeStaleTemps?(sha: string): Promise<void> };
    await store.removeStaleTemps?.(sha);
    const manifest = await this.deps.store.manifest(sha);
    if (!manifest) return;
    this.known.set(sha, manifest);
    if (manifest.stage === 'ready' || manifest.stage === 'translating') {
      if (manifest.raw && (manifest.normalized?.normalizerVersion ?? 0) < NORMALIZER_VERSION) {
        // Rebuilt offline from raw/; never re-uploaded.
        await this.update(sha, current => { current.stage = 'normalizing'; });
      } else if (manifest.stage === 'ready' && await this.translationOutdated(sha)) {
        await this.update(sha, current => { current.stage = 'translating'; });
      }
    }
    this.kick(sha);
  }

  // ---- PipelineControl ----

  status(sha: string): Promise<Manifest | undefined> {
    return this.deps.store.manifest(sha).then(manifest => manifest && this.conflictFiles.has(sha) ? { ...manifest, stage: 'conflict' } : manifest);
  }

  async requestParse(vaultPath: string): Promise<void> {
    const sha = await this.discover(vaultPath, { requested: true });
    if (sha) this.prioritize(sha);
  }

  prioritize(sha: string): void {
    void this.update(sha, manifest => { manifest.priority = true; }).then(() => {
      for (const key of this.keysFor(sha)) { this.mineruQueue.prioritize(key); this.normalizeQueue.prioritize(key); this.qwenQueue.prioritize(key); }
      this.kick(sha);
    }, error => this.deps.log.warn('优先处理失败', error));
  }

  retry(sha: string): void {
    this.cancelled.delete(sha);
    void this.resetForRetry(sha).then(() => this.kick(sha), error => this.deps.log.warn('重试失败', error));
  }

  cancel(sha: string): void {
    this.cancelled.add(sha);
    for (const key of this.keysFor(sha)) { this.mineruQueue.cancel(key); this.normalizeQueue.cancel(key); this.qwenQueue.cancel(key); }
    if (!this.drivers.has(sha)) {
      void this.store(sha).then(manifest => {
        if (manifest && ACTIVE_STAGES.has(manifest.stage)) return this.fail(sha, manifest.stage, new CancelledError(), true);
      }).finally(() => this.cancelled.delete(sha));
    }
  }

  // ---- other controls ----

  pause(): void {
    if (this.pausedState) return;
    this.pausedState = true;
    this.mineruQueue.pause(); this.normalizeQueue.pause(); this.qwenQueue.pause();
    this.deps.events.emit('pipeline:paused', { paused: true });
  }

  resume(): void {
    if (!this.pausedState) return;
    this.pausedState = false;
    this.mineruQueue.resume(); this.normalizeQueue.resume(); this.qwenQueue.resume();
    this.deps.events.emit('pipeline:paused', { paused: false });
    for (const sha of this.known.keys()) this.kick(sha);
  }

  /** Re-check papers that were waiting for approval (after the backlog confirmation). */
  kickAll(): void {
    for (const sha of this.known.keys()) this.kick(sha);
  }

  dispose(): void {
    this.disposed = true;
    this.mineruQueue.clear(); this.normalizeQueue.clear(); this.qwenQueue.clear();
  }

  /** Snapshot for the status bar and the panel, from memory (no disk reads). */
  snapshot(): PaperStatus[] {
    return [...this.known.values()].map(manifest => ({
      manifest: this.conflictFiles.has(manifest.sha256) ? { ...manifest, stage: 'conflict' } : manifest,
      conflicts: this.conflictFiles.get(manifest.sha256) ?? [],
      parse: this.parseProgress.get(manifest.sha256),
      translation: manifest.translation && { done: manifest.translation.done, total: manifest.translation.total, failed: manifest.translation.failed },
    }));
  }

  /**
   * Library papers that would go to MinerU and are not approved yet, with page counts read by pdf.js.
   * Papers with an imported cache need no upload and are not listed.
   */
  async backlog(): Promise<Array<{ sha: string; path: string; pages?: number }>> {
    const result: Array<{ sha: string; path: string; pages?: number }> = [];
    for (const manifest of [...this.known.values()]) {
      if (manifest.raw || manifest.priority || !['discovered', 'copied', 'uploading', 'parsing'].includes(manifest.stage) || this.deps.isApproved(manifest)) continue;
      const source = manifest.sources.find(item => item.inLibrary);
      if (!source) continue;
      let pages = manifest.pageCount;
      if (pages === undefined) {
        try {
          const pdf = await this.deps.openPdf(await this.deps.readPdf(source.path));
          pages = pdf.numPages;
          await pdf.destroy();
          const count = pages;
          await this.update(manifest.sha256, current => { current.pageCount = count; }, undefined, { quiet: true });
        } catch (error) {
          this.deps.log.warn(`读取页数失败：${source.path}`, error);
        }
      }
      result.push({ sha: manifest.sha256, path: source.path, ...(pages === undefined ? {} : { pages }) });
      await nextTask();
    }
    return result;
  }

  /** Drop index entries whose file no longer exists (deleted while Obsidian was closed). */
  async pruneIndex(exists: (vaultPath: string) => boolean): Promise<void> {
    for (const [vaultPath, sha] of Object.entries(await this.deps.store.paths())) {
      if (exists(vaultPath)) continue;
      await this.deps.store.setPath(vaultPath, null);
      await this.removeSource(sha, vaultPath);
    }
  }

  /** Move a conflict copy aside after you chose to keep the current file. */
  async keepCurrent(sha: string): Promise<void> {
    for (const file of await this.deps.store.conflicts(sha)) await this.deps.store.archiveConflict(sha, file);
    this.conflictFiles.delete(sha);
    const manifest = await this.deps.store.manifest(sha);
    if (manifest) {
      this.known.set(sha, manifest);
      this.deps.events.emit('paper:stage-changed', { sha, stage: manifest.stage, ...(manifest.failure ? { failure: manifest.failure } : {}) });
    }
    this.kick(sha);
  }

  // ---- discovery and the path index ----

  /** Hash a vault PDF, record it in the path index and its manifest, and start processing. */
  discover(vaultPath: string, options: { requested?: boolean } = {}): Promise<string | undefined> {
    const running = this.discovering.get(vaultPath);
    if (running) return running;
    const job = this.discoverNow(vaultPath, options).finally(() => this.discovering.delete(vaultPath));
    this.discovering.set(vaultPath, job);
    return job;
  }

  private async discoverNow(vaultPath: string, options: { requested?: boolean }): Promise<string | undefined> {
    let bytes: Uint8Array;
    try { bytes = await this.deps.readPdf(vaultPath); }
    catch (error) { this.deps.log.warn(`读取 PDF 失败：${vaultPath}`, error); return undefined; }
    const sha = await sha256Bytes(bytes);
    const previous = (await this.deps.store.paths())[vaultPath];
    if (previous && previous !== sha) await this.removeSource(previous, vaultPath);
    if (previous !== sha) await this.deps.store.setPath(vaultPath, sha);
    const inLibrary = this.deps.isInLibrary(vaultPath);
    const source: ManifestSource = { path: vaultPath, inLibrary };
    const created = !await this.deps.store.manifest(sha);
    await this.update(sha, manifest => {
      const existing = manifest.sources.find(item => item.path === vaultPath);
      if (existing) existing.inLibrary = inLibrary;
      else manifest.sources.push(source);
      if (options.requested) manifest.priority = true;
    }, () => this.newManifest(sha, [source]));
    if (created) this.deps.log.info(`新论文：${vaultPath}`);
    this.kick(sha);
    return sha;
  }

  /** Attach Zotero keys to a source (the sync knows them; the pipeline does not need them). */
  async describeSource(vaultPath: string, keys: { zoteroAttachmentKey?: string; zoteroParentKey?: string }): Promise<void> {
    const sha = (await this.deps.store.paths())[vaultPath];
    if (!sha || !await this.deps.store.manifest(sha)) return;
    await this.update(sha, manifest => {
      const source = manifest.sources.find(item => item.path === vaultPath);
      if (source) Object.assign(source, keys);
    }, undefined, { quiet: true });
  }

  async onRename(oldPath: string, newPath: string): Promise<void> {
    const sha = (await this.deps.store.paths())[oldPath];
    if (!sha) {
      if (newPath.toLowerCase().endsWith('.pdf') && this.deps.isInLibrary(newPath)) await this.discover(newPath);
      return;
    }
    await this.deps.store.setPath(oldPath, null);
    await this.deps.store.setPath(newPath, sha);
    if (await this.deps.store.manifest(sha)) {
      await this.update(sha, manifest => {
        const source = manifest.sources.find(item => item.path === oldPath);
        if (source) { source.path = newPath; source.inLibrary = this.deps.isInLibrary(newPath); }
        else manifest.sources.push({ path: newPath, inLibrary: this.deps.isInLibrary(newPath) });
      }, undefined, { quiet: true });
    }
    this.deps.events.emit('paper:path-changed', { sha, oldPath, newPath });
    this.kick(sha);
  }

  async onDelete(vaultPath: string): Promise<void> {
    const sha = (await this.deps.store.paths())[vaultPath];
    if (!sha) return;
    await this.deps.store.setPath(vaultPath, null);
    await this.removeSource(sha, vaultPath);
  }

  private async removeSource(sha: string, vaultPath: string): Promise<void> {
    if (!await this.deps.store.manifest(sha)) return;
    await this.update(sha, manifest => { manifest.sources = manifest.sources.filter(item => item.path !== vaultPath); }, undefined, { quiet: true });
  }

  // ---- driver ----

  private keysFor(sha: string): string[] {
    return [`mineru:${sha}`, `normalize:${sha}`, ...(this.qwenKeys.get(sha) ?? [])];
  }

  private kick(sha: string): void {
    if (this.disposed) return;
    if (this.drivers.has(sha)) { this.again.add(sha); return; }
    const driver = this.drive(sha).catch(error => this.deps.log.error('流水线内部错误', error)).finally(() => {
      this.drivers.delete(sha);
      if (this.again.delete(sha)) this.kick(sha);
    });
    this.drivers.set(sha, driver);
  }

  /** Wait until nothing is running (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.drivers.size) await Promise.all([...this.drivers.values()]);
  }

  private async drive(sha: string): Promise<void> {
    for (;;) {
      if (this.disposed || this.pausedState) return;
      const conflicts = await this.deps.store.conflicts(sha);
      if (conflicts.length) { this.markConflict(sha, conflicts); return; }
      if (this.conflictFiles.delete(sha)) this.deps.log.info(`冲突已解决：${sha.slice(0, 12)}`);
      const manifest = await this.store(sha);
      if (!manifest) return;
      const stage = manifest.stage;
      const approved = manifest.priority || this.deps.isApproved(manifest);
      try {
        switch (stage) {
          case 'discovered':
          case 'copied': {
            const next: Stage = manifest.raw && Object.keys(manifest.raw.files).length ? 'normalizing'
              : manifest.mineru?.batchId ? 'parsing' : 'uploading';
            if (next !== 'normalizing' && !approved) return;
            await this.update(sha, current => { current.stage = next; });
            break;
          }
          case 'uploading':
            if (!approved) return;
            await this.mineruQueue.enqueue(`mineru:${sha}`, signal => this.upload(sha, signal), { priority: manifest.priority });
            break;
          case 'parsing':
            if (!approved) return;
            await this.mineruQueue.enqueue(`mineru:${sha}`, signal => this.parse(sha, signal), { priority: manifest.priority });
            break;
          case 'normalizing':
            await this.normalizeQueue.enqueue(`normalize:${sha}`, () => this.normalize(sha), { priority: manifest.priority });
            break;
          case 'translating':
            await this.translate(sha, manifest.priority);
            break;
          default:
            return;
        }
      } catch (error) {
        if (error instanceof SourceMissingError) { this.deps.log.warn(`${sha.slice(0, 12)}：${error.message}`); return; }
        if (error instanceof ConflictError) { this.markConflict(sha, error.files); return; }
        if (this.disposed) return;
        if (error instanceof CancelledError && !this.cancelled.has(sha)) return;
        const current = await this.store(sha);
        await this.fail(sha, current?.stage ?? stage, error, error instanceof CancelledError || retryable(error));
        this.cancelled.delete(sha);
        return;
      }
    }
  }

  private markConflict(sha: string, files: string[]): void {
    const known = this.conflictFiles.get(sha);
    this.conflictFiles.set(sha, files);
    if (known && known.join('\n') === files.join('\n')) return;
    this.deps.log.warn(`iCloud 冲突副本，暂停处理 ${sha.slice(0, 12)}：${files.join('、')}`);
    this.deps.events.emit('paper:conflict', { sha, files });
    this.deps.events.emit('paper:stage-changed', { sha, stage: 'conflict' });
  }

  private async fail(sha: string, stage: Stage, error: unknown, canRetry: boolean): Promise<void> {
    const message = error instanceof CancelledError ? '已取消。' : errorMessage(error);
    this.deps.log.warn(`处理失败（${stage}）：${sha.slice(0, 12)}`, error);
    await this.update(sha, manifest => {
      manifest.failure = { stage, error: message.slice(0, 500), attempts: attemptsOf(error), at: this.iso(), retryable: canRetry };
      manifest.stage = 'failed';
    });
  }

  private async resetForRetry(sha: string): Promise<void> {
    const manifest = await this.store(sha);
    if (!manifest) return;
    const translationFailed = (manifest.translation?.failed ?? 0) > 0;
    if (manifest.stage !== 'failed' && !(manifest.stage === 'ready' && translationFailed)) return;
    const from = manifest.stage === 'failed' ? manifest.failure?.stage ?? 'copied' : 'translating';
    if (from === 'translating' || translationFailed) {
      const file = await this.deps.store.translations(sha);
      if (file && Object.keys(file.failures).length) await this.deps.store.writeTranslations(sha, { ...file, failures: {} });
    }
    await this.update(sha, current => {
      current.failure = null;
      current.stage = from === 'uploading' || from === 'parsing' ? (current.mineru?.batchId ? 'parsing' : 'copied')
        : from === 'normalizing' || from === 'translating' ? from : 'copied';
      if (current.translation) current.translation.failed = 0;
    });
  }

  // ---- steps ----

  private async sourceBytes(manifest: Manifest): Promise<{ path: string; bytes: Uint8Array }> {
    for (const source of manifest.sources) {
      try { return { path: source.path, bytes: await this.deps.readPdf(source.path) }; }
      catch { continue; }
    }
    throw new SourceMissingError();
  }

  private async upload(sha: string, signal: AbortSignal): Promise<void> {
    const manifest = await this.require(sha);
    if (manifest.mineru?.batchId) { await this.update(sha, current => { current.stage = 'parsing'; }); return; }
    const { bytes } = await this.sourceBytes(manifest);
    if (bytes.byteLength > MAX_PDF_BYTES) throw new MinerUError('MinerU 云端最大支持 200 MB 的文件。', false);
    let pageCount = manifest.pageCount;
    if (pageCount === undefined) {
      const pdf = await this.deps.openPdf(bytes);
      pageCount = pdf.numPages;
      await pdf.destroy();
    }
    if (pageCount > MAX_PDF_PAGES) throw new MinerUError(`MinerU 云端最多支持 ${MAX_PDF_PAGES} 页，这篇有 ${pageCount} 页。`, false);
    const batchId = await withRetry(async () => {
      const { batchId: id, uploadUrl } = await this.deps.mineru.requestUpload(sha);
      await this.deps.mineru.upload(uploadUrl, bytes.slice().buffer);
      return id;
    }, this.retryOptions(signal));
    // Written at once, whatever happens next: from here on only resume, never upload again.
    await this.update(sha, current => {
      current.pageCount = pageCount;
      current.mineru = { batchId, modelVersion: 'vlm', options: mineruOptions(), uploadedAt: this.iso(), origin: 'cloud' };
      current.stage = 'parsing';
    });
  }

  private async parse(sha: string, signal: AbortSignal): Promise<void> {
    const manifest = await this.require(sha);
    const batchId = manifest.mineru?.batchId;
    if (!batchId) { await this.update(sha, current => { current.stage = 'copied'; }); return; }
    const imported = manifest.mineru?.origin === 'imported-reader-cache';
    const deadline = Date.now() + POLL_DEADLINE_MS;
    for (;;) {
      let poll;
      try {
        poll = await withRetry(() => this.deps.mineru.poll(batchId), this.retryOptions(signal));
      } catch (error) {
        // A batch carried over from the old reader cache that MinerU no longer knows: upload normally.
        if (imported && error instanceof MinerUError && !error.retryable && error.status !== 401 && error.status !== 403) return this.forgetBatch(sha, `旧任务 ${batchId} 已无法续取，改为重新上传。`);
        throw error;
      }
      if (poll.state === 'failed') {
        if (imported) return this.forgetBatch(sha, `旧任务 ${batchId} 在 MinerU 端失败，改为重新上传。`);
        // The batch is dead; a manual retry uploads again. Nothing is re-uploaded automatically.
        await this.update(sha, current => { if (current.mineru) delete current.mineru.batchId; });
        throw new MinerUError(`MinerU 解析失败${poll.error ? '：' + poll.error : '。'}`, false);
      }
      if (poll.state === 'done' && poll.zipUrl) {
        const zipUrl = poll.zipUrl;
        const files = await withRetry(() => this.deps.mineru.download(zipUrl), this.retryOptions(signal));
        await this.deps.store.writeRaw(sha, files);
        const hashes: Record<string, string> = {};
        for (const [name, bytes] of Object.entries(files)) hashes[name] = await sha256Bytes(bytes);
        this.parseProgress.delete(sha);
        await this.update(sha, current => {
          current.raw = { files: hashes, complete: true };
          if (current.mineru) current.mineru.completedAt = this.iso();
          current.stage = 'normalizing';
        });
        return;
      }
      if (poll.progress) {
        this.parseProgress.set(sha, poll.progress);
        this.deps.events.emit('paper:parse-progress', { sha, ...poll.progress });
      }
      if (Date.now() > deadline) throw new MinerUError('MinerU 仍在处理，稍后重试会继续获取同一任务。', true);
      await this.sleep(this.deps.pollIntervalMs ?? POLL_INTERVAL_MS, signal);
    }
  }

  private async forgetBatch(sha: string, message: string): Promise<void> {
    this.deps.log.warn(message);
    await this.update(sha, current => {
      delete current.mineru;
      current.stage = 'copied';
    });
  }

  private async normalize(sha: string): Promise<void> {
    const manifest = await this.require(sha);
    const names = Object.keys(manifest.raw?.files ?? {});
    if (!names.length) { await this.update(sha, current => { current.stage = 'copied'; }); return; }
    const { bytes } = await this.sourceBytes(manifest);
    const pdf = await this.deps.openPdf(bytes);
    let output;
    try {
      output = await derive({
        sha,
        raw: { names, read: name => this.deps.store.readRaw(sha, name) },
        pdf,
        cropper: this.deps.createCropper(pdf),
        existingDerived: asset => this.deps.store.readDerived(sha, asset),
      });
    } finally {
      await pdf.destroy();
    }
    for (const [name, data] of Object.entries(output.derived)) await this.deps.store.writeDerived(sha, name, data);
    await this.deps.store.writeDocument(sha, output.document);
    await this.update(sha, current => {
      current.pageCount = output.document.pageCount;
      current.normalized = { normalizerVersion: output.document.normalizerVersion, at: this.iso() };
      current.stage = 'translating';
    });
    this.deps.events.emit('paper:document-updated', { sha, normalizerVersion: output.document.normalizerVersion });
  }

  private async translationOutdated(sha: string): Promise<boolean> {
    const document = await this.deps.store.document(sha);
    if (!document) return false;
    const file = await this.deps.store.translations(sha);
    const terms = this.deps.glossary();
    let index = 0;
    for (const [hash, text] of documentSegments(document)) {
      if (++index % 50 === 0) await nextTask();
      if (file?.failures[hash]) continue;
      const entry = file?.entries[hash];
      if (!entry || entry.termsKey !== termsKey(text, terms)) return true;
    }
    return false;
  }

  private async translate(sha: string, priority: boolean): Promise<void> {
    const document = await this.deps.store.document(sha);
    if (!document) { await this.update(sha, current => { current.stage = 'normalizing'; }); return; }
    const file: TranslationFile = await this.deps.store.translations(sha) ?? { schemaVersion: 1, entries: {}, failures: {} };
    const terms = this.deps.glossary();
    const segments = documentSegments(document);
    const todo: Array<[string, string, string]> = [];
    let index = 0;
    for (const [hash, text] of segments) {
      if (++index % 50 === 0) await nextTask();
      if (file.failures[hash]) continue;
      const key = termsKey(text, terms);
      if (file.entries[hash]?.termsKey !== key) todo.push([hash, text, key]);
    }
    const total = segments.size;
    const counts = () => {
      let done = 0, failed = 0;
      for (const hash of segments.keys()) {
        if (file.failures[hash]) failed++;
        else if (file.entries[hash]) done++;
      }
      return { done, failed };
    };

    let unsaved = 0;
    let writing = Promise.resolve();
    const flush = () => {
      unsaved = 0;
      const snapshot: TranslationFile = JSON.parse(JSON.stringify(file)) as TranslationFile;
      const progress = counts();
      writing = writing.then(async () => {
        await this.deps.store.writeTranslations(sha, snapshot);
        await this.update(sha, current => { current.translation = { model: FULL_TEXT_MODEL, total, ...progress, at: this.iso() }; }, undefined, { quiet: true });
        this.deps.events.emit('paper:translation-progress', { sha, total, ...progress });
      });
      return writing;
    };

    const keys = new Set<string>();
    this.qwenKeys.set(sha, keys);
    let fatal: Error | undefined;
    try {
      await Promise.all(todo.map(async ([hash, text, key]) => {
        const queueKey = `qwen:${sha}:${hash}`;
        keys.add(queueKey);
        try {
          const translated = await this.qwenQueue.enqueue(queueKey, signal => this.translateSegment(text, terms, signal), { priority });
          file.entries[hash] = { text: translated, model: FULL_TEXT_MODEL, termsKey: key, at: this.iso() };
          delete file.failures[hash];
          if (++unsaved >= FLUSH_EVERY) await flush();
        } catch (error) {
          if (error instanceof PlaceholderMismatchError) {
            file.failures[hash] = { error: 'PlaceholderMismatch', attempts: attemptsOf(error), at: this.iso() };
            unsaved++;
            return;
          }
          // Anything else (no key, quota, offline after retries, cancel) stops the paper; nothing corrupt is written.
          if (fatal === undefined) {
            fatal = error instanceof Error ? error : new Error(String(error));
            for (const other of keys) if (other !== queueKey) this.qwenQueue.cancel(other);
          }
        } finally {
          keys.delete(queueKey);
        }
      }));
    } finally {
      this.qwenKeys.delete(sha);
      await flush();
    }
    if (fatal !== undefined) throw fatal;
    await this.update(sha, current => { current.stage = 'ready'; });
  }

  private translateSegment(text: string, terms: readonly Term[], signal: AbortSignal): Promise<string> {
    let attempt = 0;
    return withRetry(run => {
      attempt = run;
      return this.deps.qwenMt.translate({ text, model: FULL_TEXT_MODEL, terms, timeoutMs: TRANSLATE_TIMEOUT_MS, signal });
    }, {
      ...this.retryOptions(signal),
      isRetryable: error => error instanceof PlaceholderMismatchError ? attempt < PLACEHOLDER_ATTEMPTS : retryable(error),
    });
  }

  // ---- manifest access ----

  private retryOptions(signal: AbortSignal) {
    return { delays: this.delays, signal, sleep: this.sleep, isRetryable: retryable };
  }

  private async store(sha: string): Promise<Manifest | undefined> {
    const manifest = await this.deps.store.manifest(sha);
    if (manifest) this.known.set(sha, manifest);
    return manifest;
  }

  private async require(sha: string): Promise<Manifest> {
    const manifest = await this.store(sha);
    if (!manifest) throw new Error('论文状态文件不存在。');
    return manifest;
  }

  private newManifest(sha: string, sources: ManifestSource[]): Manifest {
    return { schemaVersion: 1, sha256: sha, sources, stage: 'copied', failure: null, priority: false, updatedAt: this.iso() };
  }

  /**
   * Read-modify-write under a per-paper lock, so a rename and a step never lose each other's change.
   * A conflict copy next to the manifest stops every write.
   */
  private update(sha: string, change: (manifest: Manifest) => void, create?: () => Manifest, options: { quiet?: boolean } = {}): Promise<Manifest> {
    const previous = this.locks.get(sha) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const conflicts = await this.deps.store.conflicts(sha);
      if (conflicts.length) throw new ConflictError(conflicts);
      const current = await this.deps.store.manifest(sha) ?? create?.();
      if (!current) throw new Error('论文状态文件不存在。');
      const before = current.stage;
      change(current);
      current.updatedAt = this.iso();
      await this.deps.store.writeManifest(sha, current);
      this.known.set(sha, current);
      if ((current.stage !== before || create) && !options.quiet) {
        this.deps.events.emit('paper:stage-changed', { sha, stage: current.stage, ...(current.failure ? { failure: current.failure } : {}) });
      }
      return current;
    });
    this.locks.set(sha, next);
    void next.finally(() => { if (this.locks.get(sha) === next) this.locks.delete(sha); }).catch(() => undefined);
    return next;
  }

  private iso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}

function mineruOptions(): { enable_formula: boolean; enable_table: boolean; language: string } {
  return { enable_formula: MINERU_OPTIONS.enable_formula, enable_table: MINERU_OPTIONS.enable_table, language: MINERU_OPTIONS.language };
}

/** Credentials, quota and malformed results fail at once; network trouble is retried. */
export function retryable(error: unknown): boolean {
  if (error instanceof MinerUError || error instanceof QwenMtError) return error.retryable;
  if (error instanceof PlaceholderMismatchError) return true;
  if (error instanceof CancelledError || error instanceof SourceMissingError || error instanceof ConflictError) return false;
  return true;
}

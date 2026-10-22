import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256Bytes, sha256Text } from './hash';
import type { Manifest, StoredDocument, TranslationFile } from './types';

export const STORE_DIR = '.research';

/** Read access for every module (docs/contracts.md §5). */
export interface StoreReader {
  list(): Promise<string[]>;
  shaForPath(vaultPath: string): Promise<string | undefined>;
  manifest(sha: string): Promise<Manifest | undefined>;
  document(sha: string): Promise<StoredDocument | undefined>;
  translations(sha: string): Promise<TranslationFile | undefined>;
  readRaw(sha: string, relativePath: string): Promise<Uint8Array>;
  readDerived(sha: string, relativePath: string): Promise<Uint8Array | undefined>;
  assetUrl(sha: string, assetPath: string): string;
  /** iCloud conflict copies such as `manifest 2.json` in the paper directory. */
  conflicts(sha: string): Promise<string[]>;
  /** The whole vault-path → sha index. */
  paths(): Promise<Record<string, string>>;
}

export interface MinerUUpload { batchId: string; uploadUrl: string; createdAt: string }

/** Only the pipeline (library) receives this. */
export interface StoreWriter extends StoreReader {
  writeManifest(sha: string, manifest: Manifest): Promise<void>;
  /** Durable upload receipts survive manifest conflicts. Only library can read the signed URL. */
  mineruUploads(sha: string): Promise<MinerUUpload[]>;
  writeMinerUUpload(sha: string, upload: MinerUUpload): Promise<void>;
  /** Raw files are write-once: an existing file is an error, never overwritten. */
  writeRaw(sha: string, files: Record<string, Uint8Array>): Promise<void>;
  writeDerived(sha: string, relativePath: string, bytes: Uint8Array): Promise<void>;
  writeDocument(sha: string, document: StoredDocument): Promise<void>;
  writeTranslations(sha: string, file: TranslationFile): Promise<void>;
  setPath(vaultPath: string, sha: string | null): Promise<void>;
  /** Keep the current version: move the conflict copy to .research/conflicts/. */
  archiveConflict(sha: string, fileName: string): Promise<void>;
  /** Keep the conflict copy: move the current version to .research/conflicts/ and put the copy in its place. */
  keepConflictCopy(sha: string, fileName: string): Promise<void>;
  /** Remove temp files left by an interrupted write. */
  removeStaleTemps(sha: string): Promise<void>;
}

export class StoreError extends Error {
  constructor(message: string, readonly kind: 'corrupt' | 'exists' | 'invalid-path') { super(message); }
}

interface IndexFile { schemaVersion: 1; paths: Record<string, string> }

const SHA = /^[0-9a-f]{64}$/;
const CONFLICT = /^(manifest|document|translation\.zh|index|raw|derived)( \d+)(\.json)?$/;
const TEMP = /\.tmp-[0-9a-f]{12}$/;

export interface FileStoreOptions {
  /** Absolute vault path. */
  basePath: string;
  /** Turns a vault-relative path into a URL the renderer can load (adapter.getResourcePath). */
  resourcePath: (vaultRelativePath: string) => string;
  /** Reads a vault file for hashing when the path index has no entry. */
  readVaultFile: (vaultPath: string) => Promise<ArrayBuffer>;
}

export class FileStore implements StoreWriter {
  private readonly root: string;
  private index?: Promise<IndexFile>;
  private indexWrite: Promise<void> = Promise.resolve();

  constructor(private readonly options: FileStoreOptions) {
    this.root = path.join(options.basePath, STORE_DIR);
  }

  async list(): Promise<string[]> {
    try {
      return (await fs.readdir(path.join(this.root, 'papers'))).filter(name => SHA.test(name)).sort();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async shaForPath(vaultPath: string): Promise<string | undefined> {
    const known = (await this.loadIndex()).paths[vaultPath];
    if (known) return known;
    try { return await sha256Bytes(await this.options.readVaultFile(vaultPath)); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
  }

  async manifest(sha: string): Promise<Manifest | undefined> { return this.readJson(this.file(sha, 'manifest.json')); }
  async document(sha: string): Promise<StoredDocument | undefined> { return this.readJson(this.file(sha, 'document.json')); }
  async translations(sha: string): Promise<TranslationFile | undefined> { return this.readJson(this.file(sha, 'translation.zh.json')); }

  async readRaw(sha: string, relativePath: string): Promise<Uint8Array> {
    return fs.readFile(this.file(sha, 'raw', relativePath));
  }

  async readDerived(sha: string, relativePath: string): Promise<Uint8Array | undefined> {
    try { return await fs.readFile(this.file(sha, 'derived', relativePath)); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
  }

  assetUrl(sha: string, assetPath: string): string {
    const relative = safeRelative(assetPath);
    return this.options.resourcePath([STORE_DIR, 'papers', checkSha(sha), relative].join('/'));
  }

  async conflicts(sha: string): Promise<string[]> {
    try { return (await fs.readdir(this.paperDir(sha))).filter(name => CONFLICT.test(name)).sort(); }
    catch (error) { if (isMissing(error)) return []; throw error; }
  }

  async writeManifest(sha: string, manifest: Manifest): Promise<void> {
    if (manifest.sha256 !== sha) throw new StoreError('manifest 的 sha256 与目录不一致。', 'invalid-path');
    await this.writeJson(this.file(sha, 'manifest.json'), manifest);
  }

  async mineruUploads(sha: string): Promise<MinerUUpload[]> {
    const directory = this.file(sha, 'uploads');
    let names: string[];
    try { names = await fs.readdir(directory); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const uploads: MinerUUpload[] = [];
    for (const name of names.filter(name => /^[0-9a-f]{64}\.json$/.test(name))) {
      const value = await this.readJson<unknown>(path.join(directory, name));
      if (typeof value !== 'object' || value === null || !('batchId' in value) || typeof value.batchId !== 'string'
        || !('uploadUrl' in value) || typeof value.uploadUrl !== 'string' || !value.uploadUrl.startsWith('https://')
        || !('createdAt' in value) || typeof value.createdAt !== 'string' || name !== sha256Text(value.batchId) + '.json') {
        throw new StoreError('MinerU 上传记录损坏，暂停处理以免重复上传。', 'corrupt');
      }
      uploads.push({ batchId: value.batchId, uploadUrl: value.uploadUrl, createdAt: value.createdAt });
    }
    return uploads.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async writeMinerUUpload(sha: string, upload: MinerUUpload): Promise<void> {
    await writeOnce(this.file(sha, 'uploads', sha256Text(upload.batchId) + '.json'), Buffer.from(JSON.stringify(upload, null, 2) + '\n'));
  }

  async writeRaw(sha: string, files: Record<string, Uint8Array>): Promise<void> {
    for (const [name, bytes] of Object.entries(files)) await writeOnce(this.file(sha, 'raw', name), bytes);
  }

  async writeDerived(sha: string, relativePath: string, bytes: Uint8Array): Promise<void> {
    await atomicWrite(this.file(sha, 'derived', relativePath), bytes);
  }

  async writeDocument(sha: string, document: StoredDocument): Promise<void> {
    await this.writeJson(this.file(sha, 'document.json'), document);
  }

  async writeTranslations(sha: string, file: TranslationFile): Promise<void> {
    await this.writeJson(this.file(sha, 'translation.zh.json'), file);
  }

  async paths(): Promise<Record<string, string>> {
    return { ...(await this.loadIndex()).paths };
  }

  setPath(vaultPath: string, sha: string | null): Promise<void> {
    if (sha !== null) checkSha(sha);
    // Serialize index writes; each one starts from the latest in-memory state.
    const write = this.indexWrite.then(async () => {
      const index = await this.loadIndex();
      if (sha === null) delete index.paths[vaultPath];
      else index.paths[vaultPath] = sha;
      await this.writeJson(path.join(this.root, 'index.json'), index);
    });
    this.indexWrite = write.catch(() => undefined);
    return write;
  }

  async archiveConflict(sha: string, fileName: string): Promise<void> {
    if (!CONFLICT.test(fileName)) throw new StoreError(`不是冲突副本：${fileName}`, 'invalid-path');
    const destination = await this.conflictDestination(sha);
    await fs.rename(path.join(this.paperDir(sha), fileName), path.join(destination, fileName));
  }

  async keepConflictCopy(sha: string, fileName: string): Promise<void> {
    const match = CONFLICT.exec(fileName);
    if (!match) throw new StoreError(`不是冲突副本：${fileName}`, 'invalid-path');
    const currentName = match[1]! + (match[3] ?? '');
    const directory = this.paperDir(sha);
    const destination = await this.conflictDestination(sha);
    if (currentName === 'manifest.json') {
      const current = await this.manifest(sha);
      const copy = await this.readJson<Manifest>(path.join(directory, fileName));
      if (!copy || copy.sha256 !== sha || !Array.isArray(copy.sources)) throw new StoreError('冲突副本不是有效的 manifest。', 'corrupt');
      const merged = mergeManifestFacts(copy, current);
      if (current) await writeOnce(path.join(destination, currentName), Buffer.from(JSON.stringify(current, null, 2) + '\n'));
      // Keep a live manifest throughout; both snapshots' immutable facts survive every interruption.
      await this.writeManifest(sha, mergeManifestFacts(current ?? copy, copy));
      await fs.rename(path.join(directory, fileName), path.join(destination, fileName));
      await this.writeManifest(sha, merged);
      return;
    }
    try { await fs.rename(path.join(directory, currentName), path.join(destination, currentName)); }
    catch (error) { if (!isMissing(error)) throw error; }
    await fs.rename(path.join(directory, fileName), path.join(directory, currentName));
  }

  private async conflictDestination(sha: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(this.root, 'conflicts', stamp, checkSha(sha));
    await fs.mkdir(destination, { recursive: true });
    return destination;
  }

  /** Remove temp files left by an interrupted write. */
  async removeStaleTemps(sha: string): Promise<void> {
    const directory = this.paperDir(sha);
    let names: string[];
    try { names = await fs.readdir(directory, { recursive: true }); }
    catch (error) { if (isMissing(error)) return; throw error; }
    await Promise.all(names.filter(name => TEMP.test(name)).map(name => fs.rm(path.join(directory, name), { force: true })));
  }

  private loadIndex(): Promise<IndexFile> {
    this.index ??= this.readJson<IndexFile>(path.join(this.root, 'index.json'))
      .then(index => index ?? { schemaVersion: 1, paths: {} });
    return this.index;
  }

  private paperDir(sha: string): string {
    return path.join(this.root, 'papers', checkSha(sha));
  }

  private file(sha: string, ...parts: string[]): string {
    return path.join(this.paperDir(sha), ...parts.map(safeRelative));
  }

  private async readJson<T>(file: string): Promise<T | undefined> {
    let text: string;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
    try { return JSON.parse(text) as T; }
    catch { throw new StoreError(`解析存储文件损坏：${path.relative(this.root, file)}`, 'corrupt'); }
  }

  private writeJson(file: string, value: unknown): Promise<void> {
    return atomicWrite(file, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'));
  }
}

export async function atomicWrite(file: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = tempName(file);
  try {
    await writeSynced(temp, bytes);
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

async function writeSynced(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await fs.open(file, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function tempName(file: string): string {
  return `${file}.tmp-${randomBytes(6).toString('hex')}`;
}

function checkSha(sha: string): string {
  if (!SHA.test(sha)) throw new StoreError(`无效的 sha256：${sha.slice(0, 80)}`, 'invalid-path');
  return sha;
}

/** Relative paths only, no traversal; always POSIX separators. */
function safeRelative(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new StoreError(`非法的存储路径：${relativePath.slice(0, 200)}`, 'invalid-path');
  }
  return normalized;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Keep immutable facts even when the user selects an older state snapshot. */
function mergeManifestFacts(selected: Manifest, other: Manifest | undefined): Manifest {
  if (!other) return selected;
  const merged = structuredClone(selected);
  if (!merged.mineru?.batchId && other.mineru?.batchId) merged.mineru = structuredClone(other.mineru);
  if (merged.mineru) {
    const previous = new Set([...(selected.mineru?.previousBatchIds ?? []), ...(other.mineru?.previousBatchIds ?? [])]);
    if (other.mineru?.batchId && other.mineru.batchId !== merged.mineru.batchId) previous.add(other.mineru.batchId);
    previous.delete(merged.mineru.batchId ?? '');
    if (previous.size) merged.mineru.previousBatchIds = [...previous];
  }
  if (other.raw) {
    const files = { ...other.raw.files, ...merged.raw?.files };
    for (const [name, hash] of Object.entries(other.raw.files)) {
      if (merged.raw?.files[name] && merged.raw.files[name] !== hash) throw new StoreError('两份 manifest 的 raw 哈希不同，请保留当前版本。', 'corrupt');
    }
    merged.raw = { files, complete: other.raw.complete || merged.raw?.complete === true };
  }
  for (const source of other.sources) if (!merged.sources.some(item => item.path === source.path)) merged.sources.push(source);
  return merged;
}

async function writeOnce(target: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = tempName(target);
  await writeSynced(temp, bytes);
  try { await fs.link(temp, target); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      if (!Buffer.from(await fs.readFile(target)).equals(Buffer.from(bytes))) throw new StoreError('已存在的不可变文件内容不同。', 'exists');
    } else throw error;
  } finally { await fs.rm(temp, { force: true }); }
}

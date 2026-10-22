import type { StoreReader } from '../core/store';
import type { StoredDocument, TranslationFile } from '../core/types';

/** What the reader keeps in memory for one paper. */
export interface LoadedPaper {
  sha: string;
  document: StoredDocument;
  translations?: TranslationFile;
  /** Chinese/English font-size ratio, measured once on first render (architecture §6.2). */
  zhScale?: number;
}

export const MEMORY_PAPER_LIMIT = 8;

/**
 * The most recently opened papers stay in memory, so reopening one reads nothing
 * from disk; simultaneous opens share one read. Pipeline events invalidate entries.
 */
export class PaperCache {
  private readonly memory = new Map<string, LoadedPaper>();
  private readonly loading = new Map<string, Promise<LoadedPaper | undefined>>();
  private readonly versions = new Map<string, number>();
  private stopped = false;

  constructor(private readonly store: Pick<StoreReader, 'document' | 'translations'>, private readonly limit = MEMORY_PAPER_LIMIT) {}

  /** undefined when the store has no document.json for this paper yet. */
  get(sha: string): Promise<LoadedPaper | undefined> {
    if (this.stopped) return Promise.reject(new Error('插件已关闭，请重新开启阅读模式。'));
    const hit = this.memory.get(sha);
    if (hit) {
      this.memory.delete(sha);
      this.memory.set(sha, hit);
      return Promise.resolve(hit);
    }
    const existing = this.loading.get(sha);
    if (existing) return existing;
    const version = this.versions.get(sha) ?? 0;
    const job: Promise<LoadedPaper | undefined> = (async () => {
      const document = await this.store.document(sha);
      if (!document) return undefined;
      const translations = await this.store.translations(sha);
      const paper: LoadedPaper = { sha, document, ...(translations ? { translations } : {}) };
      // An entry invalidated while loading must not come back with stale content.
      if (!this.stopped && (this.versions.get(sha) ?? 0) === version) this.remember(paper);
      return paper;
    })().finally(() => {
      if (this.loading.get(sha) === job) this.loading.delete(sha);
    });
    this.loading.set(sha, job);
    return job;
  }

  /** Re-read translation.zh.json; updates the cached entry in place. */
  async refreshTranslations(sha: string): Promise<TranslationFile | undefined> {
    const translations = await this.store.translations(sha);
    const entry = this.memory.get(sha);
    if (entry && !this.stopped) {
      if (translations) entry.translations = translations;
      else delete entry.translations;
    }
    return translations;
  }

  invalidate(sha: string): void {
    this.versions.set(sha, (this.versions.get(sha) ?? 0) + 1);
    this.memory.delete(sha);
    this.loading.delete(sha);
  }

  has(sha: string): boolean { return this.memory.has(sha); }

  stop(): void {
    this.stopped = true;
    this.memory.clear();
    this.loading.clear();
  }

  private remember(paper: LoadedPaper): void {
    this.memory.delete(paper.sha);
    this.memory.set(paper.sha, paper);
    while (this.memory.size > this.limit) this.memory.delete(this.memory.keys().next().value!);
  }
}

export interface FileVersion { path: string; stat: { mtime: number; size: number } }

/**
 * sha256 per file version. The store answers from its path index and hashes the
 * PDF only when the index has no entry; unchanged files are never asked twice.
 */
export class ShaCache {
  private readonly known = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string | undefined>>();

  private readonly modified = new Set<string>();

  constructor(private readonly lookup: (path: string) => Promise<string | undefined>, private readonly verify = lookup, private readonly limit = 64) {}

  /** Once modified on this device, new versions must be hashed rather than trusting a lagging index. */
  invalidate(path: string): void { this.modified.add(path); }

  get(file: FileVersion): Promise<string | undefined> {
    const key = JSON.stringify([file.path, file.stat.mtime, file.stat.size, this.modified.has(file.path)]);
    const known = this.known.get(key);
    if (known) return Promise.resolve(known);
    let job = this.pending.get(key);
    if (!job) {
      const lookup = this.modified.has(file.path) ? this.verify : this.lookup;
      const created: Promise<string | undefined> = lookup(file.path).then(sha => {
        if (sha) {
          this.known.set(key, sha);
          while (this.known.size > this.limit) this.known.delete(this.known.keys().next().value!);
        }
        return sha;
      }).finally(() => { if (this.pending.get(key) === created) this.pending.delete(key); });
      this.pending.set(key, created);
      job = created;
    }
    return job;
  }
}

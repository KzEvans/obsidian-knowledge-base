import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ZoteroApi } from '../../src/library/zotero/api';
import { ZoteroUnavailableError } from '../../src/library/zotero/api';
import type { ZoteroCollection, ZoteroItem } from '../../src/library/zotero/naming';

export async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeFile(file: string, content: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

export async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Flush pending promise callbacks and zero-delay timers. */
export async function settle(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index++) await new Promise(resolve => setTimeout(resolve, 0));
}

/** An in-memory Zotero library behind the ZoteroApi interface. */
export class FakeZotero implements ZoteroApi {
  collectionsList: ZoteroCollection[] = [];
  items = new Map<string, ZoteroItem[]>();
  files = new Map<string, string>();
  running = true;
  bibFails = false;
  calls: string[] = [];

  async collections(): Promise<ZoteroCollection[]> {
    this.calls.push('collections');
    if (!this.running) throw new ZoteroUnavailableError('ECONNREFUSED');
    return this.collectionsList;
  }

  async collectionItems(key: string): Promise<ZoteroItem[]> {
    this.calls.push(`items:${key}`);
    return this.items.get(key) ?? [];
  }

  async attachmentPath(key: string): Promise<string> {
    this.calls.push(`file:${key}`);
    const file = this.files.get(key);
    if (!file) throw new Error(`no file for ${key}`);
    return file;
  }

  async bibtex(keys: readonly string[]): Promise<string> {
    this.calls.push(`bib:${keys.join(',')}`);
    if (this.bibFails) throw new Error('BibTeX translator failed');
    return keys.map(key => `@article{${key}}`).join('\n');
  }
}

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../core/store';
import { sha256Bytes } from '../core/hash';

/**
 * Vault-relative file access for the sync (Node fs; the plugin is desktop-only).
 * Moves go through `rename`, which is Obsidian's fileManager.renameFile in the plugin so links follow.
 */
export interface VaultFiles {
  readonly base: string;
  absolute(relative: string): string;
  isFile(relative: string): Promise<boolean>;
  read(relative: string): Promise<Uint8Array>;
  readText(relative: string): Promise<string | undefined>;
  write(relative: string, bytes: Uint8Array | string): Promise<void>;
  /** Atomic copy from outside the vault (Zotero storage), keeping the modification time. */
  copyIn(absoluteSource: string, relative: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  sha256(relative: string): Promise<string>;
  size(relative: string): Promise<number>;
}

export function createVaultFiles(base: string, rename?: (from: string, to: string) => Promise<void>): VaultFiles {
  const absolute = (relative: string) => {
    const normalized = path.posix.normalize(relative.replace(/\\/g, '/'));
    if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) throw new Error(`非法的 vault 路径：${relative.slice(0, 200)}`);
    return path.join(base, normalized);
  };
  const copyFrom = async (source: string, relative: string) => {
    const target = absolute(relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Dot-prefixed temp names are ignored by Obsidian's file watcher.
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}`);
    try {
      await fs.copyFile(source, temp);
      const stat = await fs.stat(source);
      await fs.utimes(temp, stat.atime, stat.mtime);
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true });
    }
  };
  return {
    base,
    absolute,
    async isFile(relative) {
      try { return (await fs.stat(absolute(relative))).isFile(); } catch { return false; }
    },
    read: async relative => new Uint8Array(await fs.readFile(absolute(relative))),
    async readText(relative) {
      try { return await fs.readFile(absolute(relative), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    },
    write: (relative, bytes) => atomicWrite(absolute(relative), typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes),
    copyIn: copyFrom,
    copy: (from, to) => copyFrom(absolute(from), to),
    async rename(from, to) {
      if (rename) return rename(from, to);
      await fs.mkdir(path.dirname(absolute(to)), { recursive: true });
      await fs.rename(absolute(from), absolute(to));
    },
    sha256: async relative => sha256Bytes(await fs.readFile(absolute(relative))),
    size: async relative => (await fs.stat(absolute(relative))).size,
  };
}

/** Zotero's own attachment fingerprint fallback, identical to the Python sync: `<size>:<mtime ns>`. */
export async function sourceFingerprint(absolutePath: string, md5: string | null | undefined): Promise<string> {
  if (md5) return md5;
  const stat = await fs.stat(absolutePath, { bigint: true });
  return `${stat.size}:${stat.mtimeNs}`;
}

export async function isExternalFile(absolutePath: string): Promise<boolean> {
  try { return (await fs.stat(absolutePath)).isFile(); } catch { return false; }
}

/** Local time `YYYYMMDD-HHMMSS` for history file names. */
export function historyStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Keep the replaced version: `<stem>__<stamp>__<sha8>.pdf` in the history folder. */
export async function archivePrevious(files: VaultFiles, destination: string, historyDir: string, previousSha: string): Promise<void> {
  if (!await files.isFile(destination)) return;
  const stem = path.posix.basename(destination).replace(/\.[^.]*$/, '');
  await files.copy(destination, `${historyDir}/${stem}__${historyStamp()}__${previousSha.slice(0, 8) || 'unknown'}.pdf`);
}

/** Python json.dumps(indent=2, sort_keys=True, ensure_ascii=False) + newline. */
export function sortedJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
}

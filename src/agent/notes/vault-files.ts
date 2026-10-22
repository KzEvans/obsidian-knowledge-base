import { TFile, TFolder, normalizePath } from 'obsidian';
import type { App } from 'obsidian';
import { sha256Text } from '../../core/hash';
import { snapshotOf, unchanged } from './generate';
import type { NoteFiles, NoteSnapshot } from './generate';

class ConflictError extends Error {}

/** Notes through the Vault API, so Obsidian's caches and links stay current. */
export function vaultNoteFiles(app: App): NoteFiles {
  const snapshot = async (notePath: string): Promise<NoteSnapshot | null> => {
    const file = app.vault.getAbstractFileByPath(normalizePath(notePath));
    if (!(file instanceof TFile)) return null;
    return snapshotOf(await app.vault.read(file), file.stat.mtime);
  };
  return {
    snapshot,
    async publish(notePath, text, baseline, signal) {
      signal.throwIfAborted();
      const target = normalizePath(notePath);
      if (!unchanged(baseline, await snapshot(target))) return false;
      if (!baseline) {
        await ensureFolder(app, target.split('/').slice(0, -1).join('/'));
        signal.throwIfAborted();
        try { await app.vault.create(target, text); return true; }
        catch { return false; } // created meanwhile
      }
      const file = app.vault.getAbstractFileByPath(target);
      if (!(file instanceof TFile)) return false;
      try {
        // Last check inside the atomic read-modify-write.
        await app.vault.process(file, data => {
          signal.throwIfAborted();
          if (sha256Text(data) !== baseline.hash) throw new ConflictError();
          return text;
        });
        return true;
      } catch (error) {
        if (error instanceof ConflictError) return false;
        throw error;
      }
    },
  };
}

export async function ensureFolder(app: App, folder: string): Promise<void> {
  if (!folder) return;
  let current = '';
  for (const part of folder.split('/')) {
    current = current ? `${current}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(current);
    if (existing instanceof TFolder) continue;
    if (existing) throw new Error(`${current} 不是文件夹。`);
    await app.vault.createFolder(current);
  }
}

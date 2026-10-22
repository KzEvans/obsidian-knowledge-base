import type { SyncEntry } from './sync';

/** Paper notes follow their paper's collection, and receive impact-factor metadata (architecture §4.4). */

export const NOTES_ROOT = 'wiki/papers';
const EXCLUDED = [`${NOTES_ROOT}/images/`, `${NOTES_ROOT}/close-reading/`];

export interface PaperNote {
  path: string;
  frontmatter: Record<string, unknown> | undefined;
}

export function isPrimaryPaperNote(path: string): boolean {
  return path.startsWith(`${NOTES_ROOT}/`) && path.toLowerCase().endsWith('.md') && !EXCLUDED.some(prefix => path.startsWith(prefix)) && !path.split('/').includes('..');
}

export function noteAttachment(note: PaperNote): string | undefined {
  const value = note.frontmatter?.zotero_attachment;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function noteFolder(collectionPath: string): string {
  if (collectionPath.split('/').some(part => part === '..' || part === '') && collectionPath !== '') throw new Error(`非法的分类路径：${collectionPath}`);
  return collectionPath ? `${NOTES_ROOT}/${collectionPath}` : NOTES_ROOT;
}

/** Where each note should live: `wiki/papers/<collection-path>/<same file name>`. */
export function planNoteMoves(notes: readonly PaperNote[], entries: readonly SyncEntry[]): Array<{ from: string; to: string }> {
  const byKey = new Map(entries.map(entry => [entry.attachment_key, entry]));
  const moves: Array<{ from: string; to: string }> = [];
  for (const note of notes) {
    if (!isPrimaryPaperNote(note.path)) continue;
    const key = noteAttachment(note);
    const entry = key ? byKey.get(key) : undefined;
    if (!entry) continue;
    const name = note.path.split('/').pop()!;
    const target = `${noteFolder(entry.collection_path ?? '')}/${name}`;
    if (target !== note.path) moves.push({ from: note.path, to: target });
  }
  return moves;
}

export interface NoteMoveDeps {
  exists(path: string): boolean;
  rename(from: string, to: string): Promise<void>;
  log(message: string): void;
}

/** A target that already exists is never overwritten; the move is reported instead. */
export async function applyNoteMoves(moves: ReadonlyArray<{ from: string; to: string }>, deps: NoteMoveDeps): Promise<{ moved: number; conflicts: string[] }> {
  const conflicts: string[] = [];
  let moved = 0;
  for (const move of moves) {
    if (deps.exists(move.to)) {
      conflicts.push(move.to);
      deps.log(`笔记未移动：目标已存在 ${move.to}`);
      continue;
    }
    await deps.rename(move.from, move.to);
    moved++;
  }
  return { moved, conflicts };
}

const MANAGED = ['journal', 'issn', 'impact_factor', 'impact_factor_year', 'impact_factor_source', 'impact_factor_retrieved_at'] as const;

/**
 * The frontmatter changes that bring a paper note in line with the sync's metadata.
 * An empty upstream value never clears an existing (possibly hand-curated) one; a missing key is added as null.
 */
export function metadataUpdates(frontmatter: Record<string, unknown> | undefined, metadata: Partial<Record<typeof MANAGED[number], unknown>>): Record<string, unknown> | null {
  if (!frontmatter || frontmatter.type !== 'paper') return null;
  const updates: Record<string, unknown> = {};
  for (const key of MANAGED) {
    const incoming = metadata[key];
    const authoritative = incoming !== null && incoming !== undefined && incoming !== '';
    if (key in frontmatter) {
      if (authoritative && frontmatter[key] !== incoming) updates[key] = incoming;
    } else {
      updates[key] = authoritative ? incoming : null;
    }
  }
  return Object.keys(updates).length ? updates : null;
}

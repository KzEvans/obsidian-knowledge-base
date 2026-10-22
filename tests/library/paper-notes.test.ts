import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { applyNoteMoves, isPrimaryPaperNote, metadataUpdates, planNoteMoves } from '../../src/library/zotero/notes';
import type { SyncEntry } from '../../src/library/zotero/sync';

// Port of legacy tests/test_pipeline_impact_factor.py (frontmatter backfill) and the note-follows-collection rule.

test('backfills an existing paper note', () => {
  const updates = metadataUpdates({ type: 'paper', year: '2024', reviewed: false }, {
    journal: 'Biomacromolecules', issn: '1525-7797', impact_factor: 5.5, impact_factor_year: '2024',
    impact_factor_source: 'Journal Citation Reports', impact_factor_retrieved_at: '2026-09-02T12:00:00+08:00',
  });
  assert.deepEqual(updates, {
    journal: 'Biomacromolecules', issn: '1525-7797', impact_factor: 5.5, impact_factor_year: '2024',
    impact_factor_source: 'Journal Citation Reports', impact_factor_retrieved_at: '2026-09-02T12:00:00+08:00',
  });
});

test('preserves a manual value when upstream is empty; missing journal and ISSN are added as null', () => {
  const updates = metadataUpdates({
    type: 'paper', year: '2024', impact_factor: 7.1, impact_factor_year: '2025',
    impact_factor_source: 'Manual verification', impact_factor_retrieved_at: '2026-09-02T12:00:00+08:00',
  }, { impact_factor: null, impact_factor_year: '', impact_factor_source: '', impact_factor_retrieved_at: '' });
  assert.deepEqual(updates, { journal: null, issn: null });
});

test('matching values and non-paper notes need no write', () => {
  const metadata = { journal: 'J', issn: '1', impact_factor: 5.5, impact_factor_year: '2024', impact_factor_source: 'JCR', impact_factor_retrieved_at: '' };
  assert.equal(metadataUpdates({ type: 'paper', ...metadata, impact_factor_retrieved_at: 'x' }, metadata), null);
  assert.equal(metadataUpdates({ type: 'concept' }, metadata), null);
  assert.equal(metadataUpdates(undefined, metadata), null);
});

const entry = (key: string, collection: string) => ({ attachment_key: key, collection_path: collection }) as SyncEntry;

test('notes follow their paper\'s collection by zotero_attachment; logs and image folders are left alone', () => {
  const notes = [
    { path: 'wiki/papers/2026-09-01 - A - Paper.md', frontmatter: { zotero_attachment: 'K1' } },
    { path: 'wiki/papers/DEA/Already.md', frontmatter: { zotero_attachment: 'K2' } },
    { path: 'wiki/papers/close-reading/Log.md', frontmatter: { zotero_attachment: 'K1' } },
    { path: 'wiki/papers/Other.md', frontmatter: { zotero_attachment: 'UNKNOWN' } },
    { path: 'wiki/papers/NoKey.md', frontmatter: {} },
  ];
  assert.deepEqual(planNoteMoves(notes, [entry('K1', 'DEA/Fibers'), entry('K2', 'DEA')]), [{ from: 'wiki/papers/2026-09-01 - A - Paper.md', to: 'wiki/papers/DEA/Fibers/2026-09-01 - A - Paper.md' }]);
  assert.deepEqual(planNoteMoves([{ path: 'wiki/papers/DEA/P.md', frontmatter: { zotero_attachment: 'K1' } }], [entry('K1', '')]), [{ from: 'wiki/papers/DEA/P.md', to: 'wiki/papers/P.md' }]);
  for (const value of ['wiki/papers/close-reading/log.md', 'wiki/papers/images/note.md', 'wiki/papers/../other.md']) assert.equal(isPrimaryPaperNote(value), false);
  assert.equal(isPrimaryPaperNote('wiki/papers/自适应聚合物网络/Paper.md'), true);
});

test('a note move never overwrites an existing note', async () => {
  const renamed: string[] = [];
  const { moved, conflicts } = await applyNoteMoves([{ from: 'a.md', to: 'taken.md' }, { from: 'b.md', to: 'free.md' }], {
    exists: path => path === 'taken.md', rename: async (from, to) => { renamed.push(`${from}->${to}`); }, log: () => undefined,
  });
  assert.equal(moved, 1);
  assert.deepEqual(conflicts, ['taken.md']);
  assert.deepEqual(renamed, ['b.md->free.md']);
});

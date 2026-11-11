import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildPapers, collectionTree, filterPapers, noteInfo, pairIndex, sortPapers } from '../../src/workbench/model';
import type { NoteInfo } from '../../src/workbench/model';

const item = (key: string, extra: Record<string, unknown> = {}) => ({
  active: true, attachment_key: key, destination: `sources/literature/pdf/${key}.pdf`, title: `Paper ${key}`,
  creators: [`Author ${key}`], year: '2020', journal: 'J', impact_factor: null, collection_path: '', doi: '', sha256: '', ...extra,
});
const manifest = (...items: unknown[]) => ({ items });
const note = (path: string, extra: Partial<NoteInfo> = {}): NoteInfo => ({ path, reviewed: false, ...extra });

test('only active PDF items become papers; HTML in titles is dropped', () => {
  const papers = buildPapers(manifest(
    item('A', { title: 'Nano-ZrO<sub>2</sub> muscles' }),
    item('B', { active: false }),
    item('C', { destination: 'sources/literature/pdf/C.docx' }),
    { nonsense: true },
  ), []);
  assert.deepEqual(papers.map(p => [p.key, p.title, p.state]), [['A', 'Nano-ZrO2 muscles', 'none']]);
  assert.deepEqual(buildPapers(null, []), []);
});

test('notes match by attachment, then PDF path, hash, and DOI of an older attachment', () => {
  const papers = buildPapers(manifest(
    item('A'),
    item('B'),
    item('C', { sha256: 'abc' }),
    item('D', { doi: '10.1/XYZ' }),
    item('E'),
  ), [
    note('wiki/papers/a.md', { attachment: 'A', reviewed: true }),
    note('wiki/papers/b.md', { pdfPath: 'sources/literature/pdf/B.pdf' }),
    note('wiki/papers/c.md', { sha256: 'abc' }),
    note('wiki/papers/d.md', { attachment: 'OLD', doi: '10.1/xyz' }),
  ]);
  assert.deepEqual(papers.map(p => [p.key, p.notePath, p.state]), [
    ['A', 'wiki/papers/a.md', 'reviewed'],
    ['B', 'wiki/papers/b.md', 'draft'],
    ['C', 'wiki/papers/c.md', 'draft'],
    ['D', 'wiki/papers/d.md', 'draft'],
    ['E', undefined, 'none'],
  ]);
});

test('noteInfo accepts only paper notes outside images and close-reading, and reads review state', () => {
  const resolve = (link: string) => `resolved/${link}`;
  assert.equal(noteInfo('wiki/papers/x.md', { type: 'note' }, resolve), undefined);
  assert.equal(noteInfo('笔记/x.md', { type: 'paper' }, resolve), undefined);
  assert.equal(noteInfo('wiki/papers/close-reading/x.md', { type: 'paper' }, resolve), undefined);
  const info = noteInfo('wiki/papers/DEA/x.md', { type: 'paper', status: 'reviewed', zotero_attachment: 'K', source_pdf: '[[a/b.pdf|B]]', doi: '10.1/AB' }, resolve);
  assert.deepEqual(info, { path: 'wiki/papers/DEA/x.md', attachment: 'K', sha256: undefined, doi: '10.1/ab', pdfPath: 'resolved/a/b.pdf', reviewed: true });
});

test('pairIndex maps both ways and keeps notes whose paper left the manifest', () => {
  const notes = [note('wiki/papers/a.md', { attachment: 'A' }), note('wiki/papers/gone.md', { pdfPath: 'sources/literature/pdf/gone.pdf' })];
  const { pdfFor, noteFor } = pairIndex(buildPapers(manifest(item('A')), notes), notes);
  assert.equal(pdfFor.get('wiki/papers/a.md'), 'sources/literature/pdf/A.pdf');
  assert.equal(noteFor.get('sources/literature/pdf/A.pdf'), 'wiki/papers/a.md');
  assert.equal(noteFor.get('sources/literature/pdf/gone.pdf'), 'wiki/papers/gone.md');
});

test('collection tree nests paths, counts descendants, and puts unfiled papers last', () => {
  const papers = buildPapers(manifest(
    item('A', { collection_path: 'DEA' }),
    item('B', { collection_path: 'DEA/薄膜' }),
    item('C', { collection_path: '导电聚合物' }),
    item('D'),
  ), []);
  const tree = collectionTree(papers);
  assert.deepEqual(tree.map(n => [n.name, n.path, n.count]), [['导电聚合物', '导电聚合物', 1], ['DEA', 'DEA', 2], ['未分类', '', 1]]);
  assert.deepEqual(tree[1]!.children.map(n => [n.path, n.count]), [['DEA/薄膜', 1]]);
});

test('filter by collection subtree, root only, note state and every search term', () => {
  const papers = buildPapers(manifest(
    item('A', { collection_path: 'DEA', title: 'Dielectric elastomer actuators' }),
    item('B', { collection_path: 'DEA/sub' }),
    item('C', { collection_path: 'DEAX' }),
    item('D', { journal: 'Science' }),
  ), [note('wiki/papers/a.md', { attachment: 'A' })]);
  const keys = (collection: string | null, query = '', state: 'all' | 'none' | 'draft' | 'reviewed' = 'all') =>
    filterPapers(papers, { collection, query, state }).map(p => p.key);
  assert.deepEqual(keys(null), ['A', 'B', 'C', 'D']);
  assert.deepEqual(keys('DEA'), ['A', 'B']);
  assert.deepEqual(keys(''), ['D']);
  assert.deepEqual(keys(null, '', 'draft'), ['A']);
  assert.deepEqual(keys(null, 'elastomer DIELECTRIC'), ['A']);
  assert.deepEqual(keys(null, 'science 2020'), ['D']);
});

test('sorting puts empty values last in either direction', () => {
  const papers = buildPapers(manifest(
    item('A', { year: '2019', impact_factor: 9.5 }),
    item('B', { year: '', impact_factor: null }),
    item('C', { year: '2024', impact_factor: 38 }),
  ), []);
  assert.deepEqual(sortPapers(papers, 'year', true).map(p => p.key), ['C', 'A', 'B']);
  assert.deepEqual(sortPapers(papers, 'year', false).map(p => p.key), ['A', 'C', 'B']);
  assert.deepEqual(sortPapers(papers, 'impactFactor', true).map(p => p.key), ['C', 'A', 'B']);
});

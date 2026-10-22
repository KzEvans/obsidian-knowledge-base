import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { HttpResponse } from '../../src/core/http';
import { createVaultFiles } from '../../src/library/files';
import { ZoteroUnavailableError, collectionItems, createZoteroApi } from '../../src/library/zotero/api';
import { chooseCollection, collectionTree, itemCollectionPaths, safeFilename } from '../../src/library/zotero/naming';
import { BIB_PATH, INDEX_PATH, MANIFEST_PATH, syncZotero } from '../../src/library/zotero/sync';
import type { SyncState } from '../../src/library/zotero/sync';
import { FakeZotero, exists, tempDir, writeFile } from './helpers';

// Port of legacy tests/test_collection_folders.py (the parts that remain: folders, paging, sync, moves).

test('descendants are recursive, safe and deduplicated', async () => {
  const collections = [
    { key: 'ROOT', data: { name: 'Doc', parentCollection: false } },
    { key: 'A', data: { name: 'DEA', parentCollection: 'ROOT' } },
    { key: 'B', data: { name: '层/级', parentCollection: 'A' } },
    { key: 'C', data: { name: 'images', parentCollection: 'ROOT' } },
    { key: 'OUT', data: { name: 'Other', parentCollection: false } },
  ];
  const paths = collectionTree(collections, 'ROOT');
  assert.deepEqual(paths, { ROOT: '', A: 'DEA', B: 'DEA/层_级', C: 'images (C)' });
  const paper = { key: 'PAPER', data: { collections: ['ROOT', 'B', 'A'] } };
  assert.deepEqual(itemCollectionPaths(paper, paths), ['DEA/层_级', 'DEA', '']);
  const zotero = new FakeZotero();
  zotero.items.set('B', [paper]);
  zotero.items.set('A', [paper]);
  assert.deepEqual(await collectionItems(zotero, paths), [paper]);
});

test('nested collection paths are built from the parent path, at any depth (regression)', () => {
  const collections = [
    { key: 'ROOT', data: { name: 'Doc', parentCollection: false } },
    { key: 'L3', data: { name: 'Deep', parentCollection: 'L2' } },
    { key: 'L2', data: { name: 'Mid', parentCollection: 'L1' } },
    { key: 'L1', data: { name: 'Top', parentCollection: 'ROOT' } },
    { key: 'IMG', data: { name: 'images', parentCollection: 'L1' } },
  ];
  // Only the root level reserves `images`; nested folders keep their name.
  assert.deepEqual(collectionTree(collections, 'ROOT'), { ROOT: '', L1: 'Top', L2: 'Top/Mid', L3: 'Top/Mid/Deep', IMG: 'Top/images' });
});

test('siblings with the same name (ignoring case) both get their key; long names are cut at 150 bytes', () => {
  const long = '材'.repeat(80);
  const paths = collectionTree([
    { key: 'ROOT', data: { name: 'Doc' } },
    { key: 'X1', data: { name: 'Polymers', parentCollection: 'ROOT' } },
    { key: 'X2', data: { name: 'polymers', parentCollection: 'ROOT' } },
    { key: 'L', data: { name: long, parentCollection: 'ROOT' } },
    { key: 'D', data: { name: ' .hidden. ', parentCollection: 'ROOT' } },
  ], 'ROOT');
  assert.equal(paths.X1, 'Polymers (X1)');
  assert.equal(paths.X2, 'polymers (X2)');
  assert.equal(Buffer.byteLength(paths.L!), 150);
  assert.equal(paths.D, 'hidden');
});

test('the deepest collection wins; a kept folder stays only while no deeper one exists', () => {
  assert.equal(chooseCollection(undefined, ['A/B', 'C']), 'A/B');
  assert.equal(chooseCollection('C', ['A/B', 'C']), 'A/B');
  assert.equal(chooseCollection('X/Y', ['A/B', 'X/Y']), 'X/Y');
  assert.equal(chooseCollection('Gone', ['A']), 'A');
});

test('file names keep the Zotero name, are made safe and carry the attachment key', () => {
  assert.equal(safeFilename('Cai 等 - 2024 - a: b?.pdf', 'K1'), 'Cai 等 - 2024 - a_ b (K1).pdf');
  assert.equal(safeFilename('', 'K2'), 'document (K2).pdf');
  assert.ok(Buffer.byteLength(safeFilename('长'.repeat(200) + '.pdf', 'K3')) <= 220);
});

test('API lists include later pages', async () => {
  const urls: string[] = [];
  const http = async (request: { url: string }): Promise<HttpResponse> => {
    urls.push(request.url);
    const page = request.url.includes('start=0') ? Array.from({ length: 100 }, (_, index) => ({ key: String(index) })) : [{ key: 'last' }];
    return { status: 200, text: JSON.stringify(page), arrayBuffer: new ArrayBuffer(0), json: page };
  };
  const api = createZoteroApi(http, () => 'http://localhost:23119/api/');
  assert.equal((await api.collections()).length, 101);
  assert.match(urls[1]!, /^http:\/\/localhost:23119\/api\/users\/0\/collections\?format=json&limit=100&start=100$/);
});

test('a closed Zotero surfaces as ZoteroUnavailableError', async () => {
  const api = createZoteroApi(async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); }, () => 'http://localhost:23119/api');
  await assert.rejects(api.collections(), ZoteroUnavailableError);
});

// ---- the sync itself ----

async function fixture() {
  const root = await tempDir('pw-sync-');
  const vault = path.join(root, 'vault');
  await fs.mkdir(vault);
  const zotero = new FakeZotero();
  zotero.collectionsList = [
    { key: 'ROOT', data: { name: 'Doc' } },
    { key: 'CHILD', data: { name: 'DEA', parentCollection: 'ROOT' } },
    { key: 'GRAND', data: { name: 'Fibers', parentCollection: 'CHILD' } },
  ];
  const source = path.join(root, 'zotero', 'paper.pdf');
  await writeFile(source, '%PDF-1.7 first version');
  zotero.files.set('PDF', source);
  const parent = { key: 'PARENT', data: { itemType: 'journalArticle', title: 'New paper', collections: ['GRAND'], DOI: '10.1/paper', date: '2024-05-01', creators: [{ firstName: 'Yiting', lastName: 'Cai' }], publicationTitle: 'Journal', extra: 'Impact Factor: 5.5\nImpact Factor Year: 2024' } };
  const attachment = { key: 'PDF', version: 3, data: { itemType: 'attachment', contentType: 'application/pdf', parentItem: 'PARENT', filename: 'paper.pdf' } };
  zotero.items.set('GRAND', [parent, attachment]);
  let state: SyncState | null = null;
  const saved: SyncState[] = [];
  const files = createVaultFiles(vault);
  const run = () => syncZotero({
    api: zotero, files, collectionName: 'Doc', collectionKey: 'ROOT', catalog: {}, state: state && structuredClone(state),
    enrichment: { impact_factor_cache: {} }, saveState: async next => { state = structuredClone(next); saved.push(state); }, log: () => undefined,
  });
  return { root, vault, zotero, source, parent, attachment, run, saved, getState: () => state, setState: (next: SyncState) => { state = next; } };
}

test('sync mirrors child-collection PDFs into their nested folder and writes manifest, index and bibliography', async () => {
  const { vault, zotero, run } = await fixture();
  const result = await run();
  assert.equal(result.copied, 1);
  assert.equal(result.failed, 0);
  const destination = 'sources/literature/pdf/DEA/Fibers/paper (PDF).pdf';
  assert.deepEqual(result.copiedPaths, [destination]);
  assert.equal(await fs.readFile(path.join(vault, destination), 'utf8'), '%PDF-1.7 first version');
  const manifest = JSON.parse(await fs.readFile(path.join(vault, MANIFEST_PATH), 'utf8')) as { schema_version: number; collections: Record<string, string>; items: Array<Record<string, unknown>> };
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(manifest.collections, { ROOT: '', CHILD: 'DEA', GRAND: 'DEA/Fibers' });
  const entry = manifest.items[0]!;
  assert.equal(entry.collection_path, 'DEA/Fibers');
  assert.equal(entry.impact_factor, 5.5);
  assert.equal(entry.impact_factor_year, '2024');
  assert.equal('generation_deferred' in entry, false);
  assert.ok(zotero.calls.some(call => call === 'bib:PARENT'));
  assert.match(await fs.readFile(path.join(vault, INDEX_PATH), 'utf8'), /\| DEA\/Fibers \| New paper \| 2024 \| Yiting Cai \| \[\[sources\/literature\/pdf\/DEA\/Fibers\/paper \(PDF\)\.pdf\|PDF\]\]/);
  assert.equal(await fs.readFile(path.join(vault, BIB_PATH), 'utf8'), '@article{PARENT}');
  // Keys are sorted like the Python json.dumps(sort_keys=True).
  assert.deepEqual(Object.keys(manifest), ['collection_key', 'collection_name', 'collections', 'generated_at', 'items', 'schema_version']);
});

test('an unchanged library writes nothing on the next sync', async () => {
  const { vault, run, saved } = await fixture();
  await run();
  const before = await fs.readFile(path.join(vault, MANIFEST_PATH), 'utf8');
  const second = await run();
  assert.equal(second.copied, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(second.wrote, false);
  assert.equal(saved.length, 1);
  assert.equal(await fs.readFile(path.join(vault, MANIFEST_PATH), 'utf8'), before);
});

test('state imported from the Python sync is continued without copying the PDF again', async () => {
  const { vault, source, run, setState } = await fixture();
  const first = await run();
  const legacy = structuredClone(first.state);
  // The Python state carried generation_deferred and its own last_sync; neither forces a copy.
  for (const entry of Object.values(legacy.attachments)) entry.generation_deferred = false;
  setState(legacy);
  await fs.rm(path.join(vault, MANIFEST_PATH));
  const second = await run();
  assert.equal(second.copied, 0);
  assert.equal(second.unchanged, 1);
  assert.ok(await exists(source));
});

test('a changed Zotero file is copied again and the old version goes to history', async () => {
  const { vault, source, attachment, run, zotero } = await fixture();
  await run();
  await fs.writeFile(source, '%PDF-1.7 second version');
  zotero.items.set('GRAND', [zotero.items.get('GRAND')![0]!, { ...attachment, data: { ...attachment.data, md5: 'changed' } }]);
  const result = await run();
  assert.equal(result.copied, 1);
  const history = await fs.readdir(path.join(vault, 'sources/literature/history'));
  assert.equal(history.length, 1);
  assert.match(history[0]!, /^paper \(PDF\)__\d{8}-\d{6}__[0-9a-f]{8}\.pdf$/);
  assert.equal(await fs.readFile(path.join(vault, 'sources/literature/history', history[0]!), 'utf8'), '%PDF-1.7 first version');
});

test('a paper that changed collection is moved (renamed), not copied twice', async () => {
  const { vault, zotero, parent, attachment, run } = await fixture();
  await run();
  zotero.items.set('GRAND', []);
  zotero.items.set('CHILD', [{ ...parent, data: { ...parent.data, collections: ['CHILD'] } }, attachment]);
  const result = await run();
  assert.deepEqual(result.moved, [{ from: 'sources/literature/pdf/DEA/Fibers/paper (PDF).pdf', to: 'sources/literature/pdf/DEA/paper (PDF).pdf' }]);
  assert.equal(result.copied, 0);
  assert.equal(await exists(path.join(vault, 'sources/literature/pdf/DEA/Fibers/paper (PDF).pdf')), false);
  const entry = result.state.attachments.PDF!;
  assert.equal(entry.destination, 'sources/literature/pdf/DEA/paper (PDF).pdf');
  assert.deepEqual(entry.previous_destinations, ['sources/literature/pdf/DEA/Fibers/paper (PDF).pdf']);
});

test('items removed from Zotero become inactive and their PDF is never deleted', async () => {
  const { vault, zotero, run } = await fixture();
  await run();
  zotero.items.set('GRAND', []);
  const result = await run();
  assert.equal(result.state.attachments.PDF!.active, false);
  assert.equal(result.wrote, true);
  assert.ok(await exists(path.join(vault, 'sources/literature/pdf/DEA/Fibers/paper (PDF).pdf')));
});

test('an older inactive version follows the current paper by DOI; different content at the target is not overwritten', async () => {
  const { vault, zotero, parent, attachment, run, root } = await fixture();
  await run();
  // The same paper is re-imported in Zotero as a new attachment in another collection.
  const newSource = path.join(root, 'zotero', 'new.pdf');
  await writeFile(newSource, '%PDF-1.7 reimported');
  zotero.files.set('NEW', newSource);
  zotero.items.set('GRAND', []);
  zotero.items.set('CHILD', [
    { ...parent, key: 'PARENT2', data: { ...parent.data, collections: ['CHILD'] } },
    { key: 'NEW', data: { ...attachment.data, parentItem: 'PARENT2', filename: 'new.pdf' } },
  ]);
  const result = await run();
  const old = result.state.attachments.PDF!;
  assert.equal(old.active, false);
  assert.equal(old.collection_path, 'DEA');
  assert.equal(old.destination, 'sources/literature/pdf/DEA/paper (PDF).pdf');
  assert.ok(await exists(path.join(vault, old.destination)));

  // Second scenario: something different already sits at the follow target.
  zotero.items.set('CHILD', []);
  zotero.items.set('ROOT', [
    { ...parent, key: 'PARENT2', data: { ...parent.data, collections: ['ROOT'] } },
    { key: 'NEW', data: { ...attachment.data, parentItem: 'PARENT2', filename: 'new.pdf' } },
  ]);
  await writeFile(path.join(vault, 'sources/literature/pdf/paper (PDF).pdf'), '%PDF-1.7 user file');
  const blocked = await run();
  assert.ok(blocked.errors.some(error => error.includes('未覆盖')));
  assert.equal(await fs.readFile(path.join(vault, 'sources/literature/pdf/paper (PDF).pdf'), 'utf8'), '%PDF-1.7 user file');
  assert.equal(blocked.state.attachments.PDF!.destination, 'sources/literature/pdf/DEA/paper (PDF).pdf');
});

test('a failed BibTeX export keeps the previous references.bib', async () => {
  const { vault, zotero, run } = await fixture();
  await run();
  zotero.bibFails = true;
  const result = await run();
  assert.equal(result.failed, 0);
  assert.equal(await fs.readFile(path.join(vault, BIB_PATH), 'utf8'), '@article{PARENT}');
});

test('Zotero not running: the sync stops before writing anything', async () => {
  const { vault, zotero, run, saved } = await fixture();
  zotero.running = false;
  await assert.rejects(run(), ZoteroUnavailableError);
  assert.equal(saved.length, 0);
  assert.equal(await exists(path.join(vault, 'sources')), false);
});

test('SI and peer-review attachments are not mirrored as papers', async () => {
  const { zotero, parent, attachment, run, root } = await fixture();
  const si = path.join(root, 'zotero', 'si.pdf');
  await writeFile(si, '%PDF si');
  zotero.files.set('SI', si);
  zotero.items.set('GRAND', [parent, attachment,
    { key: 'SI', data: { itemType: 'attachment', contentType: 'application/pdf', parentItem: 'PARENT', filename: 'bm4c00431_si_001.pdf', title: 'Supporting Information' } },
    { key: 'REV', data: { itemType: 'attachment', contentType: 'application/pdf', parentItem: 'PARENT', filename: 'MOESM2_ESM.pdf', title: 'Transparent Peer Review file' } }]);
  const result = await run();
  assert.deepEqual(Object.keys(result.state.attachments), ['PDF']);
});

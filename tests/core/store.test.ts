import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileStore, StoreError } from '../../src/core/store';
import { sha256Text } from '../../src/core/hash';
import type { Manifest } from '../../src/core/types';

const SHA = 'a'.repeat(64);

async function setup() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-store-'));
  const vaultFiles = new Map<string, string>();
  const store = new FileStore({
    basePath: base,
    resourcePath: relative => `app://local/${relative}`,
    readVaultFile: async vaultPath => {
      const text = vaultFiles.get(vaultPath);
      if (text === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return new TextEncoder().encode(text).buffer;
    },
  });
  return { base, store, vaultFiles, paper: path.join(base, '.research', 'papers', SHA) };
}

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return { schemaVersion: 1, sha256: SHA, sources: [], stage: 'discovered', failure: null, priority: false, updatedAt: '2026-10-21T00:00:00Z', ...overrides };
}

test('manifest writes are atomic, readable and leave no temp files', async () => {
  const { store, paper } = await setup();
  assert.equal(await store.manifest(SHA), undefined);
  await store.writeManifest(SHA, manifest({ stage: 'parsing' }));
  await store.writeManifest(SHA, manifest({ stage: 'ready' }));
  assert.equal((await store.manifest(SHA))?.stage, 'ready');
  assert.deepEqual(await fs.readdir(paper), ['manifest.json']);
  assert.match(await fs.readFile(path.join(paper, 'manifest.json'), 'utf8'), /\n$/);
  assert.deepEqual(await store.list(), [SHA]);
});

test('a manifest for another paper cannot be written into this directory', async () => {
  const { store } = await setup();
  await assert.rejects(store.writeManifest(SHA, manifest({ sha256: 'b'.repeat(64) })), StoreError);
});

test('raw files are write-once: identical bytes are accepted, different bytes are refused', async () => {
  const { store } = await setup();
  const bytes = new TextEncoder().encode('[1]');
  await store.writeRaw(SHA, { 'x_content_list.json': bytes, 'images/a.jpg': new Uint8Array([1, 2]) });
  await store.writeRaw(SHA, { 'x_content_list.json': bytes });
  await assert.rejects(store.writeRaw(SHA, { 'x_content_list.json': new TextEncoder().encode('[2]') }), (error: unknown) => error instanceof StoreError && error.kind === 'exists');
  assert.deepEqual([...await store.readRaw(SHA, 'images/a.jpg')], [1, 2]);
  assert.equal(new TextDecoder().decode(await store.readRaw(SHA, 'x_content_list.json')), '[1]');
});

test('paths that escape the paper directory and malformed hashes are refused', async () => {
  const { store } = await setup();
  await assert.rejects(store.writeRaw(SHA, { '../escape.json': new Uint8Array() }), StoreError);
  await assert.rejects(store.writeDerived(SHA, '/abs.png', new Uint8Array()), StoreError);
  await assert.rejects(store.manifest('../../etc'), StoreError);
  assert.throws(() => store.assetUrl(SHA, '../../secret'), StoreError);
  assert.equal(store.assetUrl(SHA, 'derived/source-tables-v1/block-3.png'), `app://local/.research/papers/${SHA}/derived/source-tables-v1/block-3.png`);
});

test('iCloud conflict copies are reported and can be archived, never merged', async () => {
  const { store, paper, base } = await setup();
  await store.writeManifest(SHA, manifest());
  await fs.writeFile(path.join(paper, 'manifest 2.json'), '{}');
  await fs.writeFile(path.join(paper, 'translation.zh 3.json'), '{}');
  await fs.mkdir(path.join(paper, 'raw 2'));
  await fs.writeFile(path.join(paper, 'notes 2.txt'), '');
  assert.deepEqual(await store.conflicts(SHA), ['manifest 2.json', 'raw 2', 'translation.zh 3.json']);
  await store.archiveConflict(SHA, 'manifest 2.json');
  assert.deepEqual(await store.conflicts(SHA), ['raw 2', 'translation.zh 3.json']);
  const archived = await fs.readdir(path.join(base, '.research', 'conflicts'), { recursive: true });
  assert.ok(archived.some(name => name.endsWith('manifest 2.json')));
  await assert.rejects(store.archiveConflict(SHA, 'manifest.json'), StoreError);
});

test('corrupt JSON is an error, not a missing file', async () => {
  const { store, paper } = await setup();
  await fs.mkdir(paper, { recursive: true });
  await fs.writeFile(path.join(paper, 'document.json'), '{"blocks": [');
  await assert.rejects(store.document(SHA), (error: unknown) => error instanceof StoreError && error.kind === 'corrupt');
});

test('path index answers first, falls back to hashing the vault file, and serializes concurrent updates', async () => {
  const { store, vaultFiles } = await setup();
  vaultFiles.set('papers/a.pdf', 'pdf bytes');
  assert.equal(await store.shaForPath('papers/a.pdf'), sha256Text('pdf bytes'));
  assert.equal(await store.shaForPath('papers/missing.pdf'), undefined);
  await Promise.all([store.setPath('one.pdf', SHA), store.setPath('two.pdf', SHA), store.setPath('three.pdf', SHA)]);
  await store.setPath('two.pdf', null);
  assert.deepEqual(await store.paths(), { 'one.pdf': SHA, 'three.pdf': SHA });
  vaultFiles.delete('one.pdf');
  assert.equal(await store.shaForPath('one.pdf'), SHA);
});

test('stale temp files from an interrupted write are ignored by reads and can be cleaned', async () => {
  const { store, paper } = await setup();
  await store.writeManifest(SHA, manifest());
  await fs.writeFile(path.join(paper, 'document.json.tmp-0123456789ab'), 'partial');
  assert.equal(await store.document(SHA), undefined);
  await store.removeStaleTemps(SHA);
  assert.deepEqual(await fs.readdir(paper), ['manifest.json']);
});

test('keeping a conflict copy moves the current file aside and puts the copy in its place', async () => {
  const { store, paper, base } = await setup();
  await store.writeManifest(SHA, manifest({ stage: 'ready' }));
  await fs.writeFile(path.join(paper, 'manifest 2.json'), JSON.stringify(manifest({ stage: 'parsing' })));
  await store.keepConflictCopy(SHA, 'manifest 2.json');
  assert.equal((await store.manifest(SHA))?.stage, 'parsing');
  assert.deepEqual(await store.conflicts(SHA), []);
  const archived = await fs.readdir(path.join(base, '.research', 'conflicts'), { recursive: true });
  assert.ok(archived.some(name => name.endsWith(`${SHA}/manifest.json`)));
  await fs.mkdir(path.join(paper, 'raw 2'));
  await store.keepConflictCopy(SHA, 'raw 2');
  assert.ok((await fs.stat(path.join(paper, 'raw'))).isDirectory());
  await assert.rejects(store.keepConflictCopy(SHA, 'manifest.json'), StoreError);
});

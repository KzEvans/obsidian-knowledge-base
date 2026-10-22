import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MEMORY_PAPER_LIMIT, PaperCache, ShaCache } from '../../src/reader/cache';
import type { StoredDocument, TranslationFile } from '../../src/core/types';

// The memory-cache semantics of legacy/pdf-reading-mode/tests/service-cache.test.ts that still
// apply now that the pipeline owns parsing: reuse, sharing, retry after failure, bounded memory, stop.

interface Deferred { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
function deferred(): Deferred {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

const sha = (index: number) => index.toString(16).padStart(64, '0');

function fakeStore() {
  const documents = new Map<string, StoredDocument>();
  const translations = new Map<string, TranslationFile>();
  const gates: Deferred[] = [];
  const reads = { document: 0, translations: 0 };
  const store = {
    async document(key: string) {
      reads.document++;
      const gate = gates.shift();
      if (gate) await gate.promise;
      const document = documents.get(key);
      return document ? structuredClone(document) : undefined;
    },
    async translations(key: string) { reads.translations++; return translations.get(key); },
  };
  const add = (key: string, normalizerVersion = 1) => {
    documents.set(key, { schemaVersion: 2, sha256: key, normalizerVersion, pageCount: 1, blocks: [], warnings: [], assets: {} });
  };
  return { store, documents, translations, gates, reads, add };
}

test('reopening a cached paper reads nothing more and keeps measured layout data', async () => {
  const { store, reads, add } = fakeStore();
  add(sha(1));
  const cache = new PaperCache(store);
  const first = (await cache.get(sha(1)))!;
  first.zhScale = 0.9;
  for (let index = 0; index < 10; index++) assert.equal(await cache.get(sha(1)), first);
  assert.deepEqual(reads, { document: 1, translations: 1 });
  assert.equal((await cache.get(sha(1)))?.zhScale, 0.9);
});

test('simultaneous opens share one store read', async () => {
  const { store, reads, gates, add } = fakeStore();
  add(sha(1));
  const gate = deferred();
  gates.push(gate);
  const cache = new PaperCache(store);
  const opens = [cache.get(sha(1)), cache.get(sha(1)), cache.get(sha(1))];
  await Promise.resolve();
  assert.equal(reads.document, 1);
  gate.resolve();
  const [a, b, c] = await Promise.all(opens);
  assert.ok(a && a === b && b === c);
  assert.deepEqual(reads, { document: 1, translations: 1 });
});

test('a failed read is dropped so the next open retries', async () => {
  const { store, reads, gates, add } = fakeStore();
  add(sha(1));
  const gate = deferred();
  gates.push(gate);
  const cache = new PaperCache(store);
  const settled = Promise.allSettled([cache.get(sha(1)), cache.get(sha(1))]);
  await Promise.resolve();
  gate.reject(new Error('Temporary read failure'));
  assert.ok((await settled).every(result => result.status === 'rejected'));
  assert.ok(await cache.get(sha(1)));
  assert.equal(reads.document, 2);
});

test('a paper without document.json is not remembered, so it appears once the pipeline writes it', async () => {
  const { store, reads, add } = fakeStore();
  const cache = new PaperCache(store);
  assert.equal(await cache.get(sha(1)), undefined);
  add(sha(1));
  assert.ok(await cache.get(sha(1)));
  assert.equal(reads.document, 2);
});

test('memory keeps the 8 most recently opened papers', async () => {
  const { store, reads, add } = fakeStore();
  const cache = new PaperCache(store);
  assert.equal(MEMORY_PAPER_LIMIT, 8);
  for (let index = 0; index <= 8; index++) add(sha(index));
  const first = await cache.get(sha(0));
  for (let index = 1; index <= 7; index++) await cache.get(sha(index));
  // Touch the oldest so it becomes the most recent.
  assert.equal(await cache.get(sha(0)), first);
  await cache.get(sha(8));
  assert.equal(reads.document, 9);
  assert.equal(await cache.get(sha(0)), first);
  assert.equal(reads.document, 9);
  assert.equal(cache.has(sha(1)), false);
  await cache.get(sha(1));
  assert.equal(reads.document, 10);
});

test('an updated document invalidates the entry, and a load started before cannot restore it', async () => {
  const { store, gates, reads, add } = fakeStore();
  add(sha(1), 1);
  const cache = new PaperCache(store);
  const gate = deferred();
  gates.push(gate);
  const stale = cache.get(sha(1));
  await Promise.resolve();
  cache.invalidate(sha(1));
  gate.resolve();
  await stale;
  assert.equal(cache.has(sha(1)), false);
  add(sha(1), 2);
  assert.equal((await cache.get(sha(1)))?.document.normalizerVersion, 2);
  assert.equal(reads.document, 2);
  assert.ok(cache.has(sha(1)));
});

test('translations refresh in place on the cached entry', async () => {
  const { store, translations, add } = fakeStore();
  add(sha(1));
  const cache = new PaperCache(store);
  const paper = (await cache.get(sha(1)))!;
  assert.equal(paper.translations, undefined);
  translations.set(sha(1), { schemaVersion: 1, entries: { a: { text: '译文', model: 'm', termsKey: 'k', at: 'now' } }, failures: {} });
  await cache.refreshTranslations(sha(1));
  assert.equal((await cache.get(sha(1)))?.translations?.entries.a?.text, '译文');
});

test('a stopped cache refuses reuse', async () => {
  const { store, add } = fakeStore();
  add(sha(1));
  const cache = new PaperCache(store);
  await cache.get(sha(1));
  cache.stop();
  await assert.rejects(cache.get(sha(1)), /插件已关闭/);
});

test('sha lookups are shared per file version and redone only when the file changes', async () => {
  let lookups = 0;
  const gate = deferred();
  const shas = new ShaCache(async path => { lookups++; await gate.promise; return path === 'missing.pdf' ? undefined : sha(lookups); });
  const file = { path: 'a.pdf', stat: { mtime: 1, size: 10 } };
  const pending = [shas.get(file), shas.get(file)];
  gate.resolve();
  const [first, second] = await Promise.all(pending);
  assert.equal(first, second);
  assert.equal(await shas.get({ ...file }), first);
  assert.equal(lookups, 1);
  assert.notEqual(await shas.get({ path: 'a.pdf', stat: { mtime: 2, size: 10 } }), first);
  assert.equal(lookups, 2);
  // Renaming is a different key but resolves through the store's path index.
  await shas.get({ path: 'b.pdf', stat: { mtime: 2, size: 10 } });
  assert.equal(lookups, 3);
  assert.equal(await shas.get({ path: 'missing.pdf', stat: { mtime: 1, size: 1 } }), undefined);
  await shas.get({ path: 'missing.pdf', stat: { mtime: 1, size: 1 } });
  assert.equal(lookups, 5);
});

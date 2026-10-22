import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { MinerUError } from '../../src/core/mineru';
import type { Manifest } from '../../src/core/types';
import { importReaderCache } from '../../src/library/migration';
import { deferred, settle, writeFile } from './helpers';
import { CONTENT_LIST, addPdf, pipelineFixture } from './pipeline-fixture';

const PDF = 'sources/literature/pdf/recovery.pdf';

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await settle(2);
  }
  assert.fail('condition was not reached');
}

for (const error of [new Error('client timed out after the server accepted PUT'), new MinerUError('HTTP 502 after PUT', true, 502)]) {
  test(`an accepted PUT followed by ${error.message} resumes the same batch without another PUT`, async () => {
    const f = await pipelineFixture();
    const sha = await addPdf(f, PDF, error.message);
    f.mineru.acceptedUploadFailures = [error];
    const pipeline = f.create();
    await pipeline.discover(PDF);
    await pipeline.idle();
    assert.equal((await f.store.manifest(sha))?.stage, 'ready');
    assert.equal(f.mineru.requests, 1);
    assert.equal(f.mineru.uploads, 1);
  });
}

test('a restart while PUT is in flight polls the persisted batch, and the old instance writes nothing after dispose', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'restart in PUT');
  const gate = deferred();
  f.mineru.uploadGate = gate.promise;
  const first = f.create();
  await first.discover(PDF);
  await waitFor(() => f.mineru.uploads === 1);
  const saved = await f.store.manifest(sha);
  first.dispose();
  const second = f.create();
  await second.start();
  // The server has received the bytes even though the first client's PUT is unresolved.
  await waitFor(async () => (await f.store.manifest(sha))?.stage === 'ready' || f.mineru.requests > 1);
  gate.resolve();
  await Promise.all([first.idle(), second.idle()]);
  assert.equal(saved?.mineru?.batchId, 'batch-1');
  assert.equal(f.mineru.requests, 1);
  assert.equal(f.mineru.uploads, 1);
  assert.equal((await f.store.manifest(sha))?.stage, 'ready');
});

test('a conflict after requesting an upload cannot erase its batch, even when keeping an older manifest copy', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'conflict in PUT');
  const gate = deferred();
  f.mineru.uploadGate = gate.promise;
  const pipeline = f.create();
  await pipeline.discover(PDF);
  await waitFor(() => f.mineru.uploads === 1);
  const current = (await f.store.manifest(sha))!;
  const older: Manifest = { ...current, stage: 'copied' };
  delete older.mineru;
  await fs.writeFile(path.join(f.paperDir(sha), 'manifest 2.json'), JSON.stringify(older));
  gate.resolve();
  await pipeline.idle();
  assert.equal((await pipeline.status(sha))?.stage, 'conflict');
  await pipeline.resolveConflict(sha, 'manifest 2.json', 'copy');
  await pipeline.idle();
  assert.equal((await f.store.manifest(sha))?.stage, 'ready');
  assert.equal(f.mineru.requests, 1);
  assert.equal(f.mineru.uploads, 1);
});

test('a conflict before the batch can reach manifest is recovered from its durable receipt on restart', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'conflict before PUT');
  const request = f.mineru.requestUpload.bind(f.mineru);
  f.mineru.requestUpload = async () => {
    const result = await request();
    await fs.copyFile(path.join(f.paperDir(sha), 'manifest.json'), path.join(f.paperDir(sha), 'manifest 2.json'));
    return result;
  };
  const first = f.create();
  await first.discover(PDF);
  await first.idle();
  first.dispose();
  const second = f.create();
  await second.start();
  await second.idle();
  f.mineru.pollScript = [{ state: 'waiting-file' }];
  await second.resolveConflict(sha, 'manifest 2.json', 'copy');
  await second.idle();
  assert.equal((await f.store.manifest(sha))?.stage, 'ready');
  assert.equal(f.mineru.requests, 1);
  assert.equal(f.mineru.uploads, 1);
});

test('an interrupted old-cache import succeeds on the next run with a different date', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'old import');
  const cache = path.join(f.base, 'cache');
  await writeFile(path.join(cache, `${sha}-vlm-v1`, 'x_content_list.json'), JSON.stringify(CONTENT_LIST));
  const original = f.store.writeManifest.bind(f.store);
  f.store.writeManifest = async () => { throw new Error('crashed after raw write'); };
  const interrupted = await importReaderCache(cache, f.store, () => new Date('2026-10-21'));
  assert.equal(interrupted.errors.length, 1);
  f.store.writeManifest = original;
  const recovered = await importReaderCache(cache, f.store, () => new Date('2026-10-22'));
  assert.deepEqual(recovered.errors, []);
  assert.deepEqual(recovered.imported, [sha]);
  assert.equal((await f.store.manifest(sha))?.stage, 'normalizing');
});

for (const error of [new MinerUError('Token not configured', false), new MinerUError('quota', false, 200), new MinerUError('rate limit', true, 429)]) {
  test(`an imported batch survives ${error.message}`, async () => {
    const f = await pipelineFixture();
    const sha = await addPdf(f, PDF, error.message);
    await f.store.writeManifest(sha, {
      schemaVersion: 1, sha256: sha, sources: [{ path: PDF, inLibrary: true }], stage: 'parsing', failure: null, priority: false, updatedAt: 'x',
      mineru: { batchId: 'old-batch', modelVersion: 'vlm', options: { enable_formula: true, enable_table: true, language: 'en' }, origin: 'imported-reader-cache' },
    });
    f.mineru.pollScript = Array.from({ length: 4 }, () => error);
    const pipeline = f.create();
    await pipeline.start();
    await pipeline.idle();
    assert.equal((await f.store.manifest(sha))?.mineru?.batchId, 'old-batch');
    assert.equal(f.mineru.requests, 0);
  });
}

test('cancel at a stage transition prevents the next network step and does not survive a manual retry', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'cancel transition');
  const pipeline = f.create();
  const off = f.events.on('paper:stage-changed', event => { if (event.stage === 'parsing') pipeline.cancel(sha); });
  await pipeline.discover(PDF);
  await pipeline.idle();
  assert.equal((await f.store.manifest(sha))?.stage, 'failed');
  assert.equal(f.mineru.polls, 0);
  off();
  pipeline.retry(sha);
  await waitFor(async () => (await f.store.manifest(sha))?.stage === 'ready');
  assert.equal(f.mineru.uploads, 1);
});

test('cancel while scanning translations prevents all Qwen enqueues', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'cancel before translate');
  const pipeline = f.create();
  const original = f.store.translations.bind(f.store);
  f.store.translations = async hash => { pipeline.cancel(sha); return original(hash); };
  await pipeline.discover(PDF);
  await pipeline.idle();
  assert.equal((await f.store.manifest(sha))?.stage, 'failed');
  assert.deepEqual(f.qwen.calls, []);
});

test('keeping an older manifest preserves the current raw hashes and batch', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'raw conflict');
  const pipeline = f.create();
  await pipeline.discover(PDF);
  await pipeline.idle();
  const ready = (await f.store.manifest(sha))!;
  const older: Manifest = { ...ready, stage: 'copied' };
  delete older.raw;
  delete older.mineru;
  await fs.writeFile(path.join(f.paperDir(sha), 'manifest 2.json'), JSON.stringify(older));
  await pipeline.resolveConflict(sha, 'manifest 2.json', 'copy');
  await pipeline.idle();
  const kept = (await f.store.manifest(sha))!;
  assert.deepEqual(kept.raw, ready.raw);
  assert.equal(kept.mineru?.batchId, ready.mineru?.batchId);
  assert.equal(f.mineru.requests, 1);
});

test('a failed import with an old timestamped marker can recover without rewriting that raw file', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'old marker');
  const cache = path.join(f.base, 'cache');
  await writeFile(path.join(cache, `${sha}-vlm-v1`, 'x_content_list.json'), JSON.stringify(CONTENT_LIST));
  await importReaderCache(cache, f.store);
  const markerPath = path.join(f.paperDir(sha), 'raw', 'IMPORTED.json');
  const marker: unknown = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  assert.ok(typeof marker === 'object' && marker !== null);
  const oldBytes = JSON.stringify({ ...marker, importedAt: '2026-10-20T00:00:00Z' }, null, 2) + '\n';
  await fs.writeFile(markerPath, oldBytes);
  await fs.rm(path.join(f.paperDir(sha), 'manifest.json'));
  const result = await importReaderCache(cache, f.store);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.imported, [sha]);
  assert.equal(await fs.readFile(markerPath, 'utf8'), oldBytes);
});

test('an unavailable old cache is excluded from backlog and never uploaded even after approval', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'evicted old cache');
  const cache = path.join(f.base, 'cache');
  await writeFile(path.join(cache, `${sha}-vlm-v1`, 'x_content_list.json'), 'invalid content download');
  const original = f.store.writeRaw.bind(f.store);
  f.store.writeRaw = async () => { throw new Error('iCloud download unavailable'); };
  const imported = await importReaderCache(cache, f.store);
  assert.equal(imported.errors.length, 1);
  f.store.writeRaw = original;
  f.approved.all = false;
  const pipeline = f.create({ hasLegacyCache: async hash => hash === sha });
  await pipeline.discover(PDF);
  await pipeline.idle();
  assert.deepEqual(await pipeline.backlog(), []);
  f.approved.all = true;
  pipeline.kickAll();
  await pipeline.idle();
  assert.equal(f.mineru.requests, 0);
  assert.notEqual((await f.store.manifest(sha))?.stage, 'failed');
});

test('old raw cache takes precedence over an existing failed upload manifest', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'failed before import');
  f.approved.all = false;
  const pipeline = f.create();
  await pipeline.discover(PDF);
  await pipeline.idle();
  const manifest = (await f.store.manifest(sha))!;
  await f.store.writeManifest(sha, { ...manifest, stage: 'failed', failure: { stage: 'uploading', attempts: 1, retryable: true, error: 'offline', at: 'x' } });
  const cache = path.join(f.base, 'cache');
  await writeFile(path.join(cache, `${sha}-vlm-v1`, 'x_content_list.json'), JSON.stringify(CONTENT_LIST));
  const result = await importReaderCache(cache, f.store);
  assert.deepEqual(result.imported, [sha]);
  assert.equal((await f.store.manifest(sha))?.stage, 'normalizing');
  assert.equal((await f.store.manifest(sha))?.failure, null);
});

test('a PUT that did not arrive is retried at the same upload URL after waiting-file', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'PUT retry');
  f.mineru.uploadFailures = [new Error('offline before PUT reached server')];
  f.mineru.pollScript = [{ state: 'waiting-file' }];
  const pipeline = f.create();
  await pipeline.discover(PDF);
  await pipeline.idle();
  assert.equal((await f.store.manifest(sha))?.stage, 'ready');
  assert.equal(f.mineru.requests, 1);
  assert.equal(f.mineru.uploads, 1);
  assert.deepEqual(f.mineru.uploadUrls, ['https://upload.example/put', 'https://upload.example/put']);
});

test('startup retries transient failures once, and leaves cancelled papers stopped', async () => {
  for (const cancelled of [false, true]) {
    const f = await pipelineFixture();
    const sha = await addPdf(f, PDF, 'startup retry ' + cancelled);
    f.mineru.requestFailures = Array.from({ length: 4 }, () => new Error('offline'));
    const first = f.create();
    await first.discover(PDF);
    await first.idle();
    first.dispose();
    if (cancelled) {
      const manifest = (await f.store.manifest(sha))!;
      await f.store.writeManifest(sha, { ...manifest, failure: { ...manifest.failure!, error: '已取消。' } });
    }
    const second = f.create();
    await second.start();
    await second.idle();
    assert.equal((await f.store.manifest(sha))?.stage, cancelled ? 'failed' : 'ready');
    assert.equal(f.mineru.requests, cancelled ? 4 : 5);
  }
});

test('dispose during translation prevents late writes and progress events', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'dispose translating');
  const gate = deferred();
  f.qwen.gate = gate.promise;
  const pipeline = f.create();
  await pipeline.discover(PDF);
  await waitFor(() => f.qwen.calls.length > 0);
  const manifestBefore = await fs.readFile(path.join(f.paperDir(sha), 'manifest.json'), 'utf8');
  const eventsBefore = f.emitted.length;
  pipeline.dispose();
  gate.resolve();
  await pipeline.idle();
  assert.equal(await fs.readFile(path.join(f.paperDir(sha), 'manifest.json'), 'utf8'), manifestBefore);
  assert.equal(await f.store.translations(sha), undefined);
  assert.equal(f.emitted.length, eventsBefore);
});

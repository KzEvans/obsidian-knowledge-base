import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { NORMALIZER_VERSION } from '../../src/core/derive';
import { MinerUError } from '../../src/core/mineru';
import { PlaceholderMismatchError, QwenMtError, TRANSLATOR_VERSION } from '../../src/core/qwen-mt';
import type { Manifest, TranslationFile } from '../../src/core/types';
import { FLUSH_EVERY } from '../../src/library/pipeline/pipeline';
import { deferred, settle } from './helpers';
import { addPdf, pipelineFixture, resultFiles, retryableNetworkError } from './pipeline-fixture';

const PDF = 'sources/literature/pdf/DEA/Paper (K1).pdf';
/** Distinct translatable segments of CONTENT_LIST: title, "Abstract", abstract paragraph and 12 paragraphs. */
const SEGMENTS = 15;

async function untilStage(pipeline: { idle(): Promise<void> }, read: () => Promise<Manifest | undefined>, stage: Manifest['stage']) {
  for (let round = 0; round < 200; round++) {
    await pipeline.idle();
    if ((await read())?.stage === stage) return;
    await settle(2);
  }
  assert.fail(`never reached ${stage}; at ${(await read())?.stage}`);
}

test('a library PDF goes discovered → ready with one upload, raw files, a document and translations', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'paper one');
  const pipeline = f.create();
  assert.equal(await pipeline.discover(PDF), sha);
  await untilStage(pipeline, () => f.store.manifest(sha), 'ready');

  const manifest = (await f.store.manifest(sha))!;
  assert.equal(f.mineru.uploads, 1);
  assert.equal(manifest.mineru?.batchId, 'batch-1');
  assert.equal(manifest.mineru?.origin, 'cloud');
  assert.equal(manifest.raw?.complete, true);
  // Every member of the result is kept, including the original PDF.
  assert.deepEqual(Object.keys(manifest.raw.files).sort(), ['auto/paper_content_list.json', 'full.md', 'paper_origin.pdf']);
  assert.equal(manifest.normalized?.normalizerVersion, NORMALIZER_VERSION);
  assert.deepEqual(manifest.sources, [{ path: PDF, inLibrary: true }]);
  assert.deepEqual(await f.store.paths(), { [PDF]: sha });
  const translations = (await f.store.translations(sha))!;
  assert.equal(Object.keys(translations.entries).length, SEGMENTS);
  assert.deepEqual(manifest.translation && { total: manifest.translation.total, done: manifest.translation.done, failed: manifest.translation.failed }, { total: SEGMENTS, done: SEGMENTS, failed: 0 });
  const stages = f.emitted.filter(event => event.name === 'paper:stage-changed').map(event => (event.payload as { stage: string }).stage);
  assert.deepEqual(stages, ['copied', 'uploading', 'parsing', 'normalizing', 'translating', 'ready']);
  assert.ok(f.emitted.some(event => event.name === 'paper:document-updated'));
  assert.ok(f.emitted.filter(event => event.name === 'paper:translation-progress').length >= 2);
});

test('without approval nothing is uploaded; approving later starts it', async () => {
  const f = await pipelineFixture();
  f.approved.all = false;
  const sha = await addPdf(f, PDF, 'waiting');
  const pipeline = f.create();
  await pipeline.discover(PDF);
  await pipeline.idle();
  assert.equal((await f.store.manifest(sha))?.stage, 'copied');
  assert.equal(f.mineru.requests, 0);
  assert.deepEqual((await pipeline.backlog()).map(item => [item.sha, item.pages]), [[sha, 2]]);
  f.approved.all = true;
  pipeline.kickAll();
  await untilStage(pipeline, () => f.store.manifest(sha), 'ready');
  assert.equal(f.mineru.uploads, 1);
});

test('a PDF outside the library is processed on request (the reader asked first) and first in line', async () => {
  const f = await pipelineFixture();
  f.approved.all = false;
  const outside = 'Inbox/other.pdf';
  const sha = await addPdf(f, outside, 'outside');
  const pipeline = f.create();
  await pipeline.requestParse(outside);
  await untilStage(pipeline, () => f.store.manifest(sha), 'ready');
  const manifest = (await pipeline.status(sha))!;
  assert.deepEqual(manifest.sources, [{ path: outside, inLibrary: false }]);
  assert.equal(manifest.priority, true);
});

test('restart while MinerU is still parsing: the new instance resumes the same batch and never uploads again', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'restart');
  f.mineru.pollDefault = { state: 'running', progress: { done: 1, total: 2 } };
  const first = f.create();
  await first.discover(PDF);
  for (let round = 0; round < 50 && f.mineru.polls < 3; round++) await settle(2);
  assert.equal(f.mineru.uploads, 1);
  assert.equal((await f.store.manifest(sha))?.mineru?.batchId, 'batch-1');
  first.dispose();
  await first.idle();

  f.mineru.pollDefault = { state: 'done', zipUrl: 'https://cdn.example/r.zip' };
  const second = f.create();
  await second.start();
  await untilStage(second, () => f.store.manifest(sha), 'ready');
  assert.equal(f.mineru.uploads, 1);
  assert.equal(f.mineru.requests, 1);
  assert.ok(f.emitted.some(event => event.name === 'paper:parse-progress'));
});

test('restart during translation keeps what was saved and translates only the rest', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'translate restart');
  const gate = deferred();
  let served = 0;
  f.qwen.behaviour = async request => {
    if (++served > FLUSH_EVERY) await gate.promise;
    return `译：${request.text}`;
  };
  const first = f.create();
  await first.discover(PDF);
  for (let round = 0; round < 100 && Object.keys((await f.store.translations(sha))?.entries ?? {}).length < FLUSH_EVERY; round++) await settle(2);
  const saved = Object.keys((await f.store.translations(sha))!.entries).length;
  assert.equal(saved, FLUSH_EVERY);
  first.dispose();
  gate.resolve();
  await first.idle();
  assert.equal((await f.store.manifest(sha))?.stage, 'translating');

  f.qwen.calls = [];
  f.qwen.behaviour = request => `译：${request.text}`;
  const second = f.create();
  await second.start();
  await untilStage(second, () => f.store.manifest(sha), 'ready');
  const entries = (await f.store.translations(sha))!.entries;
  assert.equal(Object.keys(entries).length, SEGMENTS);
  assert.ok(f.qwen.calls.length <= SEGMENTS - FLUSH_EVERY + 4, `re-translated ${f.qwen.calls.length}`);
  assert.equal(f.mineru.uploads, 1);
});

test('network interruptions are retried with backoff; a request that never reached MinerU is not counted as an upload', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'flaky');
  f.mineru.requestFailures = [new Error('net::ERR_INTERNET_DISCONNECTED')];
  f.mineru.uploadFailures = [new MinerUError('PDF 上传失败，HTTP 502。', true, 502)];
  f.mineru.pollScript = [{ state: 'waiting-file' }, retryableNetworkError(), { state: 'pending' }, retryableNetworkError()];
  const pipeline = f.create();
  await pipeline.discover(PDF);
  await untilStage(pipeline, () => f.store.manifest(sha), 'ready');
  assert.equal(f.mineru.uploads, 1);
  // Only the failed URL request is repeated; PUT retries reuse the batch and URL.
  assert.equal(f.mineru.requests, 2);
  assert.equal((await f.store.manifest(sha))?.mineru?.batchId, 'batch-1');
});

test('an outage that outlasts the retries fails the stage visibly; retry continues from there', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'outage');
  f.mineru.requestFailures = Array.from({ length: 4 }, () => new Error('offline'));
  const pipeline = f.create();
  await pipeline.discover(PDF);
  await untilStage(pipeline, () => f.store.manifest(sha), 'failed');
  const failed = (await f.store.manifest(sha))!;
  assert.equal(failed.failure?.stage, 'uploading');
  assert.equal(failed.failure?.attempts, 4);
  assert.equal(failed.failure?.retryable, true);
  assert.equal(failed.mineru, undefined);
  assert.equal(f.mineru.uploads, 0);
  pipeline.retry(sha);
  await untilStage(pipeline, () => f.store.manifest(sha), 'ready');
  assert.equal(f.mineru.uploads, 1);
  assert.equal((await f.store.manifest(sha))?.failure, null);
});

test('a bad token fails at once without retries', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'token');
  f.mineru.requestFailures = [new MinerUError('MinerU Token 无效或已过期，请在设置中更新。', false, 401)];
  const pipeline = f.create();
  await pipeline.discover(PDF);
  await untilStage(pipeline, () => f.store.manifest(sha), 'failed');
  assert.equal(f.mineru.requests, 1);
  assert.equal((await f.store.manifest(sha))?.failure?.retryable, false);
});

test('a failed MinerU task retains its batch through restart and manual retry', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'mineru failed');
  f.mineru.pollScript = [{ state: 'failed', error: 'file damaged' }];
  const pipeline = f.create();
  await pipeline.discover(PDF);
  await untilStage(pipeline, () => f.store.manifest(sha), 'failed');
  const manifest = (await f.store.manifest(sha))!;
  assert.match(manifest.failure!.error, /file damaged/);
  assert.equal(manifest.failure?.stage, 'parsing');
  assert.equal(manifest.raw, undefined);
  assert.equal(f.mineru.uploads, 1);
  // A restart does not touch a failed paper.
  const restarted = f.create();
  await restarted.start();
  await restarted.idle();
  assert.equal(f.mineru.uploads, 1);
  restarted.retry(sha);
  await untilStage(restarted, () => f.store.manifest(sha), 'ready');
  assert.equal(f.mineru.uploads, 1);
  assert.equal((await f.store.manifest(sha))?.mineru?.batchId, manifest.mineru?.batchId);
  pipeline.dispose();
});

test('an iCloud conflict copy stops the paper without overwriting anything; keeping the current file resumes it', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'conflict');
  f.mineru.pollDefault = { state: 'running' };
  const pipeline = f.create();
  await pipeline.discover(PDF);
  for (let round = 0; round < 50 && f.mineru.polls < 2; round++) await settle(2);
  pipeline.dispose();
  await pipeline.idle();
  const manifestFile = path.join(f.paperDir(sha), 'manifest.json');
  await fs.writeFile(path.join(f.paperDir(sha), 'manifest 2.json'), '{"stage":"ready"}');
  const before = await fs.readFile(manifestFile, 'utf8');

  f.mineru.pollDefault = { state: 'done', zipUrl: 'https://cdn.example/r.zip' };
  const second = f.create();
  await second.start();
  await second.idle();
  assert.equal((await second.status(sha))?.stage, 'conflict');
  assert.equal(await fs.readFile(manifestFile, 'utf8'), before);
  assert.equal(await fs.readFile(path.join(f.paperDir(sha), 'manifest 2.json'), 'utf8'), '{"stage":"ready"}');
  assert.ok(f.emitted.some(event => event.name === 'paper:conflict' && (event.payload as { files: string[] }).files[0] === 'manifest 2.json'));
  assert.equal(second.snapshot()[0]?.manifest.stage, 'conflict');

  await second.resolveConflict(sha, 'manifest 2.json', 'current');
  await untilStage(second, () => f.store.manifest(sha), 'ready');
  assert.deepEqual(await f.store.conflicts(sha), []);
  assert.equal(f.mineru.uploads, 1);
});

test('keeping the conflict copy puts it in place, moves the current file aside, and never replaces raw/', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'keep copy');
  const pipeline = f.create();
  await pipeline.discover(PDF);
  await untilStage(pipeline, () => f.store.manifest(sha), 'ready');
  const ready = (await f.store.manifest(sha))!;
  // The other Mac's copy says the paper is still waiting; keeping it makes this one continue from there.
  await fs.writeFile(path.join(f.paperDir(sha), 'translation.zh 2.json'), JSON.stringify({ schemaVersion: 1, entries: {}, failures: {} }));
  await fs.mkdir(path.join(f.paperDir(sha), 'raw 2'));
  const second = f.create();
  await second.start();
  await second.idle();
  assert.equal((await second.status(sha))?.stage, 'conflict');
  await assert.rejects(second.resolveConflict(sha, 'raw 2', 'copy'), /只能保留当前版本/);
  await second.resolveConflict(sha, 'translation.zh 2.json', 'copy');
  assert.equal((await second.status(sha))?.stage, 'conflict', 'raw 2 still pending');
  await second.resolveConflict(sha, 'raw 2', 'current');
  assert.deepEqual(await f.store.conflicts(sha), []);
  assert.deepEqual((await f.store.translations(sha))!.entries, {});
  const archived = await fs.readdir(path.join(f.base, '.research', 'conflicts'), { recursive: true });
  assert.ok(archived.some(name => name.endsWith('translation.zh.json')));
  assert.ok(archived.some(name => name.endsWith('raw 2')));
  assert.equal((await f.store.manifest(sha))?.stage, ready.stage);
});

test('renaming or moving the PDF mid-processing updates the index and sources and the work continues', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'moving');
  const gate = deferred();
  f.mineru.uploadGate = gate.promise;
  const pipeline = f.create();
  await pipeline.discover(PDF);
  for (let round = 0; round < 50 && f.mineru.requests < 1; round++) await settle(2);
  const moved = 'sources/literature/pdf/Fibers/Paper (K1).pdf';
  f.vault.set(moved, f.vault.get(PDF)!);
  f.vault.delete(PDF);
  await pipeline.onRename(PDF, moved);
  gate.resolve();
  await untilStage(pipeline, () => f.store.manifest(sha), 'ready');
  const manifest = (await f.store.manifest(sha))!;
  assert.deepEqual(manifest.sources, [{ path: moved, inLibrary: true }]);
  assert.equal(manifest.mineru?.batchId, 'batch-1');
  assert.deepEqual(await f.store.paths(), { [moved]: sha });
  assert.ok(f.emitted.some(event => event.name === 'paper:path-changed' && (event.payload as { newPath: string }).newPath === moved));
  assert.equal(f.mineru.uploads, 1);
});

test('a PDF that is gone waits instead of failing, and continues when it reappears', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'gone');
  f.approved.all = false;
  const pipeline = f.create();
  await pipeline.discover(PDF);
  const bytes = f.vault.get(PDF)!;
  f.vault.delete(PDF);
  await pipeline.onDelete(PDF);
  f.approved.all = true;
  pipeline.kickAll();
  await pipeline.idle();
  assert.equal((await f.store.manifest(sha))?.stage, 'uploading');
  assert.equal(f.mineru.requests, 0);
  const back = 'sources/literature/pdf/Back.pdf';
  f.vault.set(back, bytes);
  await pipeline.discover(back);
  await untilStage(pipeline, () => f.store.manifest(sha), 'ready');
});

test('formula translations from the old method are redone once; prose translations and new ones are kept', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'translator version');
  f.mineru.files = () => ({
    ...resultFiles(),
    'auto/paper_content_list.json': new TextEncoder().encode(JSON.stringify([
      { type: 'text', text: 'The modulus $Y$ is measured.', page_idx: 0, bbox: [100, 100, 900, 200] },
      { type: 'text', text: 'Plain prose without formulas.', page_idx: 0, bbox: [100, 300, 900, 400] },
    ])),
  });
  const pipeline = f.create();
  await pipeline.discover(PDF);
  await untilStage(pipeline, () => f.store.manifest(sha), 'ready');
  const first = (await f.store.translations(sha))!;
  assert.ok(Object.values(first.entries).every(entry => entry.translator === TRANSLATOR_VERSION));

  // Simulate entries written before the method change.
  const downgraded: TranslationFile = JSON.parse(JSON.stringify(first)) as TranslationFile;
  for (const entry of Object.values(downgraded.entries)) { delete entry.translator; entry.text = `旧：${entry.text}`; }
  await f.store.writeTranslations(sha, downgraded);
  const translated: string[] = [];
  f.qwen.behaviour = request => { translated.push(request.text); return `译：${request.text}`; };
  await f.store.writeManifest(sha, { ...(await f.store.manifest(sha))!, stage: 'translating' });
  const restarted = f.create();
  await restarted.start();
  await untilStage(restarted, () => f.store.manifest(sha), 'ready');
  assert.deepEqual(translated, ['The modulus $Y$ is measured.']);
  const texts = Object.values((await f.store.translations(sha))!.entries).map(entry => entry.text).sort();
  assert.deepEqual(texts, ['旧：译：Plain prose without formulas.', '译：The modulus $Y$ is measured.']);
  assert.equal(f.mineru.uploads, 1);
});

test('placeholder errors after core fallback are recorded once; manual retry preserves successful translations', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'placeholders');
  const flaky = new Map<string, number>();
  f.qwen.behaviour = request => {
    if (request.text.startsWith('Paragraph number 3 ')) throw new PlaceholderMismatchError();
    if (request.text.startsWith('Paragraph number 4 ')) {
      const seen = (flaky.get(request.text) ?? 0) + 1;
      flaky.set(request.text, seen);
      if (seen === 1) throw new PlaceholderMismatchError();
    }
    return `译：${request.text}`;
  };
  const pipeline = f.create();
  await pipeline.discover(PDF);
  await untilStage(pipeline, () => f.store.manifest(sha), 'ready');
  const file = (await f.store.translations(sha))!;
  const failures = Object.values(file.failures);
  assert.equal(failures.length, 2);
  assert.ok(failures.every(failure => failure.error === 'PlaceholderMismatch' && failure.attempts === 1));
  assert.equal(Object.keys(file.entries).length, SEGMENTS - 2);
  assert.ok(Object.values(file.entries).every(entry => entry.text.startsWith('译：')));
  assert.equal((await f.store.manifest(sha))?.translation?.failed, 2);
  assert.equal(flaky.size, 1);
  assert.ok([...flaky.values()].every(count => count === 1));
  const callsBeforeRetry = f.qwen.calls.length;

  f.qwen.behaviour = request => `译：${request.text}`;
  pipeline.retry(sha);
  for (let round = 0; round < 200 && Object.keys((await f.store.translations(sha))!.entries).length < SEGMENTS; round++) await settle(2);
  await untilStage(pipeline, () => f.store.manifest(sha), 'ready');
  const fixed = (await f.store.translations(sha))!;
  assert.deepEqual(fixed.failures, {});
  assert.equal(Object.keys(fixed.entries).length, SEGMENTS);
  assert.equal((await f.store.manifest(sha))?.translation?.failed, 0);
  assert.equal(f.qwen.calls.length - callsBeforeRetry, 2);
  for (const [hash, entry] of Object.entries(file.entries)) assert.deepEqual(fixed.entries[hash], entry);
  assert.equal(f.mineru.uploads, 1);
});

test('a missing DashScope key stops translation at once, keeping finished segments', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'no key');
  let calls = 0;
  f.qwen.behaviour = request => {
    if (++calls > 2) throw new QwenMtError('请先在设置中保存阿里云百炼 API Key。', false);
    return `译：${request.text}`;
  };
  const pipeline = f.create();
  await pipeline.discover(PDF);
  await untilStage(pipeline, () => f.store.manifest(sha), 'failed');
  const manifest = (await f.store.manifest(sha))!;
  assert.equal(manifest.failure?.stage, 'translating');
  assert.equal(manifest.failure?.retryable, false);
  const file = (await f.store.translations(sha))!;
  assert.ok(Object.keys(file.entries).length <= 4);
  assert.deepEqual(file.failures, {});
});

test('a glossary change re-translates only the segments that use the changed term', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'glossary');
  const pipeline = f.create();
  await pipeline.discover(PDF);
  await untilStage(pipeline, () => f.store.manifest(sha), 'ready');
  pipeline.dispose();
  f.qwen.calls = [];
  f.glossary.push({ source: 'dielectric elastomer', target: '介电弹性体' });
  const second = f.create();
  await second.start();
  await untilStage(second, () => f.store.manifest(sha), 'ready');
  assert.deepEqual(f.qwen.calls, ['We show that dielectric elastomer works.']);
});

test('an older normalizer version is rebuilt offline from raw/, never re-uploaded', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'normalizer');
  const pipeline = f.create();
  await pipeline.discover(PDF);
  await untilStage(pipeline, () => f.store.manifest(sha), 'ready');
  pipeline.dispose();
  const manifest = (await f.store.manifest(sha))!;
  await f.store.writeManifest(sha, { ...manifest, normalized: { normalizerVersion: NORMALIZER_VERSION - 1, at: manifest.updatedAt } });
  f.qwen.calls = [];
  const second = f.create();
  await second.start();
  await untilStage(second, () => f.store.manifest(sha), 'ready');
  assert.equal((await f.store.manifest(sha))?.normalized?.normalizerVersion, NORMALIZER_VERSION);
  assert.equal(f.mineru.uploads, 1);
  assert.equal(f.mineru.downloads, 1);
  // Unchanged text keeps its translation.
  assert.deepEqual(f.qwen.calls, []);
});

test('a batch carried over from the old reader cache is resumed; if MinerU no longer knows it, the paper is uploaded normally', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'cai 2024');
  await f.store.writeManifest(sha, {
    schemaVersion: 1, sha256: sha, sources: [], stage: 'parsing', failure: null, priority: false, updatedAt: 'x',
    mineru: { batchId: 'old-batch', modelVersion: 'vlm', options: { enable_formula: true, enable_table: true, language: 'en' }, origin: 'imported-reader-cache' },
  });
  f.mineru.pollScript = [new MinerUError('MinerU 返回错误，代码 -60012。', false, 200, -60012)];
  const pipeline = f.create();
  await pipeline.start();
  await pipeline.discover(PDF);
  await untilStage(pipeline, () => f.store.manifest(sha), 'ready');
  assert.equal(f.mineru.polls >= 2, true);
  assert.equal(f.mineru.uploads, 1);
  assert.equal((await f.store.manifest(sha))?.mineru?.origin, 'cloud');
});

test('cancel stops a paper and marks it failed; pause holds new work until resume', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'cancel');
  f.mineru.pollDefault = { state: 'running' };
  const pipeline = f.create();
  await pipeline.discover(PDF);
  for (let round = 0; round < 50 && f.mineru.polls < 2; round++) await settle(2);
  pipeline.cancel(sha);
  await untilStage(pipeline, () => f.store.manifest(sha), 'failed');
  assert.match((await f.store.manifest(sha))!.failure!.error, /取消/);

  const other = await addPdf(f, 'sources/literature/pdf/Two.pdf', 'pause');
  f.mineru.pollDefault = { state: 'done', zipUrl: 'https://cdn.example/r.zip' };
  pipeline.pause();
  await pipeline.discover('sources/literature/pdf/Two.pdf');
  await pipeline.idle();
  assert.equal((await f.store.manifest(other))?.stage, 'copied');
  pipeline.resume();
  await untilStage(pipeline, () => f.store.manifest(other), 'ready');
  assert.deepEqual(f.emitted.filter(event => event.name === 'pipeline:paused').map(event => event.payload), [{ paused: true }, { paused: false }]);
});

test('the same PDF in two collections shares one store entry listing both sources', async () => {
  const f = await pipelineFixture();
  const sha = await addPdf(f, PDF, 'shared');
  const second = 'sources/literature/pdf/Fibers/Paper (K2).pdf';
  f.vault.set(second, f.vault.get(PDF)!);
  const pipeline = f.create();
  await Promise.all([pipeline.discover(PDF), pipeline.discover(second)]);
  await untilStage(pipeline, () => f.store.manifest(sha), 'ready');
  assert.deepEqual((await f.store.manifest(sha))!.sources.map(source => source.path).sort(), [second, PDF].sort());
  assert.equal(f.mineru.uploads, 1);
});

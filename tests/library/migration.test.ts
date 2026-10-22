import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FileStore } from '../../src/core/store';
import { importLegacyState, importReaderCache } from '../../src/library/migration';
import { applyLegacyConfig, defaultSettings, readSettings } from '../../src/library/settings';
import { exists, tempDir, writeFile } from './helpers';
import { CONTENT_LIST, addPdf, pipelineFixture } from './pipeline-fixture';

const COMPLETE = 'a'.repeat(64);
const JOB_ONLY = 'b'.repeat(64);

/** A pdf-reading-mode cache as the old plugin left it. */
async function oldCache(root: string) {
  const complete = path.join(root, `${COMPLETE}-vlm-v1`);
  await writeFile(path.join(complete, 'u_content_list.json'), JSON.stringify(CONTENT_LIST));
  await writeFile(path.join(complete, 'u_content_list_v2.json'), '[]');
  await writeFile(path.join(complete, 'u_model.json'), '{}');
  await writeFile(path.join(complete, 'layout.json'), '{}');
  await writeFile(path.join(complete, 'full.md'), '# Title');
  await writeFile(path.join(complete, 'images', 'fig.jpg'), new Uint8Array([0xff, 0xd8, 0xff]));
  await writeFile(path.join(complete, 'result.json'), '{"document":{}}');
  await writeFile(path.join(complete, 'performance.json'), '{}');
  await writeFile(path.join(complete, 'fallback-v2', 'block-1.png'), 'old crop');
  await writeFile(path.join(complete, 'source-tables-v1', 'block-2.png'), 'old crop');
  await writeFile(path.join(complete, 'fallback', 'block-3.png'), 'old crop');
  await writeFile(path.join(root, `${JOB_ONLY}-vlm-v1`, 'job.json'), JSON.stringify({ batchId: 'cai-2024-batch', uploaded: true }));
  await writeFile(path.join(root, 'not-a-cache', 'x.json'), '{}');
  return { complete };
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of await fs.readdir(directory, { recursive: true })) {
    const file = path.join(directory, name);
    if ((await fs.stat(file)).isFile()) result[name] = (await fs.readFile(file)).toString('base64');
  }
  return result;
}

test('old reader caches are imported into raw/ with IMPORTED.json; crops, result.json and job-only dirs are handled; old files are untouched', async () => {
  const root = await tempDir('pw-migrate-');
  const cache = path.join(root, 'cache');
  await oldCache(cache);
  const before = await snapshot(cache);
  const store = new FileStore({ basePath: path.join(root, 'vault'), resourcePath: relative => relative, readVaultFile: async () => new ArrayBuffer(0) });

  const result = await importReaderCache(cache, store, () => new Date('2026-10-21T00:00:00Z'));
  assert.deepEqual(result.imported, [COMPLETE]);
  assert.deepEqual(result.resumed, [JOB_ONLY]);
  assert.deepEqual(result.errors, []);

  const manifest = (await store.manifest(COMPLETE))!;
  assert.equal(manifest.stage, 'normalizing');
  assert.equal(manifest.mineru?.origin, 'imported-reader-cache');
  assert.equal(manifest.mineru?.batchId, undefined);
  assert.equal(manifest.raw?.complete, false);
  assert.deepEqual(Object.keys(manifest.raw.files).sort(), ['IMPORTED.json', 'full.md', 'images/fig.jpg', 'layout.json', 'u_content_list.json', 'u_content_list_v2.json', 'u_model.json']);
  const imported = JSON.parse(new TextDecoder().decode(await store.readRaw(COMPLETE, 'IMPORTED.json'))) as { origin: string; missing: string[] };
  assert.equal(imported.origin, 'imported-reader-cache');
  assert.ok(imported.missing.length > 0);
  const rawDir = path.join(root, 'vault', '.research', 'papers', COMPLETE, 'raw');
  for (const name of ['result.json', 'performance.json', 'fallback-v2', 'source-tables-v1', 'fallback']) assert.equal(await exists(path.join(rawDir, name)), false, name);
  assert.equal(await exists(path.join(root, 'vault', '.research', 'papers', COMPLETE, 'derived')), false);

  const job = (await store.manifest(JOB_ONLY))!;
  assert.equal(job.stage, 'parsing');
  assert.equal(job.mineru?.batchId, 'cai-2024-batch');
  assert.equal(job.raw, undefined);

  assert.deepEqual(await snapshot(cache), before);
  // Running again changes nothing.
  const again = await importReaderCache(cache, store);
  assert.deepEqual(again.imported, []);
  assert.deepEqual(again.skipped.sort(), [COMPLETE, JOB_ONLY]);
});

test('an imported cache is normalized offline and translated without any MinerU call; the job-only paper resumes its batch first', async () => {
  const f = await pipelineFixture();
  const cache = path.join(f.base, 'old-cache');
  const pdfPath = 'sources/literature/pdf/Chen 2021 (3Y45NZ44).pdf';
  const sha = await addPdf(f, pdfPath, 'chen 2021');
  await writeFile(path.join(cache, `${sha}-vlm-v1`, 'x_content_list.json'), JSON.stringify(CONTENT_LIST));
  const caiPath = 'sources/literature/pdf/Cai 2024 (2MBHXG4J).pdf';
  const cai = await addPdf(f, caiPath, 'cai 2024');
  await writeFile(path.join(cache, `${cai}-vlm-v1`, 'job.json'), JSON.stringify({ batchId: 'cai-batch', uploaded: true }));
  await importReaderCache(cache, f.store);

  // Before the backlog is confirmed, only offline work happens.
  f.approved.all = false;
  const pipeline = f.create();
  await pipeline.start();
  await pipeline.discover(pdfPath);
  await pipeline.discover(caiPath);
  for (let round = 0; round < 100 && (await f.store.manifest(sha))?.stage !== 'ready'; round++) { await pipeline.idle(); await new Promise(resolve => setTimeout(resolve, 0)); }
  assert.equal((await f.store.manifest(sha))?.stage, 'ready');
  assert.equal(f.mineru.requests + f.mineru.polls + f.mineru.downloads, 0);
  assert.equal((await f.store.manifest(cai))?.stage, 'parsing');
  // The job-only paper is in the confirmation list; the imported one is not.
  assert.deepEqual((await pipeline.backlog()).map(item => item.sha), [cai]);

  f.approved.all = true;
  pipeline.kickAll();
  for (let round = 0; round < 100 && (await f.store.manifest(cai))?.stage !== 'ready'; round++) { await pipeline.idle(); await new Promise(resolve => setTimeout(resolve, 0)); }
  assert.equal((await f.store.manifest(cai))?.stage, 'ready');
  assert.equal(f.mineru.uploads, 0);
  assert.ok(f.mineru.polls >= 1);
});

test('legacy sync state files are copied into the plugin folder once and the old files stay as they were', async () => {
  const root = await tempDir('pw-legacy-');
  const legacy = path.join(root, 'system', 'zotero-sync');
  await writeFile(path.join(legacy, 'state.json'), '{"attachments":{}}');
  await writeFile(path.join(legacy, 'enrichment-cache.json'), '{"impact_factor_cache":{}}');
  const plugin = path.join(root, 'plugin');
  assert.deepEqual(await importLegacyState(legacy, plugin, ['state.json', 'enrichment-cache.json']), ['state.json', 'enrichment-cache.json']);
  await fs.writeFile(path.join(plugin, 'state.json'), '{"attachments":{"NEW":{}}}');
  assert.deepEqual(await importLegacyState(legacy, plugin, ['state.json', 'enrichment-cache.json']), []);
  assert.equal(await fs.readFile(path.join(plugin, 'state.json'), 'utf8'), '{"attachments":{"NEW":{}}}');
  assert.equal(await fs.readFile(path.join(legacy, 'state.json'), 'utf8'), '{"attachments":{}}');
});

test('legacy config.json becomes library settings', () => {
  const settings = defaultSettings();
  applyLegacyConfig(settings, {
    api_base: 'http://localhost:23119/api', collection_key: 'ABCD1234', collection_name: 'Doc',
    automatic_impact_factor: { enabled: true, max_journals_per_run: 3, refresh_days: 60, retry_days: 7, timeout_seconds: 10 },
    impact_factors: { 'Example Journal': { impact_factor: 4.2 } },
    supplementary_information: { enabled: false, refresh_days: 20 },
    literature_dir: 'sources/literature', vault_path: '/somewhere',
  });
  assert.equal(settings.collectionKey, 'ABCD1234');
  assert.equal(settings.automaticImpactFactor.maxJournalsPerRun, 3);
  assert.equal(settings.automaticImpactFactor.timeoutSeconds, 30, 'clamped to the Python minimum');
  assert.deepEqual(settings.impactFactors, { 'Example Journal': { impact_factor: 4.2 } });
  assert.equal(settings.supportingInformation.enabled, false);
  assert.equal(settings.supportingInformation.refreshDays, 20);
  assert.equal(settings.supportingInformation.retryDays, 7);
});

test('readSettings tolerates missing and malformed fields', () => {
  assert.deepEqual(readSettings(undefined), defaultSettings());
  assert.deepEqual(readSettings('nonsense'), defaultSettings());
  const settings = readSettings({
    zoteroApi: 42, collectionName: '  Papers ', pipelinePaused: 'yes',
    backlog: { decision: 'maybe', deferred: ['short', 'c'.repeat(64), 7] },
    automaticImpactFactor: { maxJournalsPerRun: -3, refreshDays: 'x' }, supportingInformation: null, impactFactors: [1, 2],
  });
  assert.equal(settings.zoteroApi, 'http://localhost:23119/api');
  assert.equal(settings.collectionName, 'Papers');
  assert.equal(settings.pipelinePaused, false);
  assert.deepEqual(settings.backlog, { decision: null, deferred: ['c'.repeat(64)] });
  assert.equal(settings.automaticImpactFactor.maxJournalsPerRun, 1);
  assert.equal(settings.automaticImpactFactor.refreshDays, 90);
  assert.deepEqual(settings.impactFactors, {});
  assert.equal(settings.supportingInformation.enabled, true);
});

import { strict as assert } from 'node:assert';
import path from 'node:path';
import { test } from 'node:test';
import type { HttpResponse } from '../../src/core/http';
import { createVaultFiles } from '../../src/library/files';
import { runEnrichment } from '../../src/library/zotero/enrich';
import { DEFAULT_AUTOMATIC_IMPACT_FACTOR } from '../../src/library/zotero/impact-factor';
import type { EnrichmentState } from '../../src/library/zotero/impact-factor';
import { DEFAULT_SUPPORTING } from '../../src/library/zotero/supporting';
import { MANIFEST_PATH, syncZotero } from '../../src/library/zotero/sync';
import { FakeZotero, exists, tempDir, writeFile } from './helpers';

// Port of legacy tests/test_sync_enrichment.py: the primary sync never waits for network enrichment,
// and enrichment writes only auxiliary state.

async function fixture() {
  const root = await tempDir('pw-enrich-');
  const vault = path.join(root, 'vault');
  const source = path.join(root, 'paper.pdf');
  await writeFile(source, '%PDF-test');
  const zotero = new FakeZotero();
  zotero.collectionsList = [{ key: 'COLLECTION', data: { name: 'Fixture' } }];
  zotero.items.set('COLLECTION', [
    { key: 'PARENT', data: { itemType: 'journalArticle', title: 'Paper', publicationTitle: 'Journal', ISSN: '1234-5678', url: 'https://www.nature.com/x', creators: [] } },
    { key: 'ATTACH', data: { itemType: 'attachment', contentType: 'application/pdf', parentItem: 'PARENT', filename: 'paper.pdf' } },
  ]);
  zotero.files.set('ATTACH', source);
  return { root, vault, zotero, files: createVaultFiles(vault) };
}

test('the primary sync uses only the Zotero API and the cached metrics', async () => {
  const { zotero, files, vault } = await fixture();
  const enrichment: EnrichmentState = { impact_factor_cache: {} };
  await syncZotero({ api: zotero, files, collectionName: 'Fixture', collectionKey: 'COLLECTION', catalog: {}, state: null, enrichment, saveState: async () => undefined, log: () => undefined });
  assert.ok(await exists(path.join(vault, MANIFEST_PATH)));
  assert.deepEqual(enrichment, { impact_factor_cache: {} });
});

test('enrichment writes only the enrichment cache and the SI manifest', async () => {
  const { zotero, files, vault } = await fixture();
  let savedEnrichment: EnrichmentState | undefined;
  let agentCalls = 0;
  const offline = async (): Promise<HttpResponse> => { throw new Error('offline'); };
  await runEnrichment({
    api: zotero, collectionName: 'Fixture', collectionKey: 'COLLECTION',
    enrichment: { impact_factor_cache: {} }, enrichmentMissing: true,
    saveEnrichment: async state => { savedEnrichment = state; },
    impactFactor: { settings: DEFAULT_AUTOMATIC_IMPACT_FACTOR, catalog: {}, http: offline, agent: { runReadOnly: async () => { agentCalls++; return '{"results":[]}'; } } },
    supporting: { settings: DEFAULT_SUPPORTING, files, client: { get: async () => { throw new Error('offline'); }, postJson: async () => { throw new Error('offline'); } } },
    log: () => undefined,
  });
  assert.equal(agentCalls, 1);
  assert.equal(savedEnrichment?.impact_factor_cache['issn:12345678']?.status, 'unavailable');
  assert.ok(await exists(path.join(vault, DEFAULT_SUPPORTING.manifest)));
  assert.equal(await exists(path.join(vault, 'sources/literature/pdf')), false);
  assert.equal(await exists(path.join(vault, MANIFEST_PATH)), false);
});

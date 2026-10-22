import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { HttpResponse } from '../../src/core/http';
import type { AgentRunner } from '../../src/core/services';
import { CACHE_SCHEMA_VERSION, DEFAULT_AUTOMATIC_IMPACT_FACTOR, isoNow, metricKey, refreshAutomaticImpactFactors, trustedSourceUrl, validateResult } from '../../src/library/zotero/impact-factor';
import type { EnrichmentState } from '../../src/library/zotero/impact-factor';

// Port of legacy tests/test_automatic_impact_factor.py; Codex is replaced by core's AgentRunner.

const noHttp = async (): Promise<HttpResponse> => { throw new Error('no network in tests'); };

function agent(reply: () => string | Promise<string>) {
  const prompts: Array<{ prompt: string; options: Parameters<AgentRunner['runReadOnly']>[1] }> = [];
  const runner: AgentRunner = { runReadOnly: async (prompt, options) => { prompts.push({ prompt, options }); return reply(); } };
  return { runner, prompts };
}

const parent = { publicationTitle: 'Example Journal', ISSN: '1234-5678', url: 'https://www.nature.com/example/article', extra: '' };
const payload = {
  results: [{
    lookup_key: 'issn:12345678', journal: 'Example Journal', impact_factor: 4.9, impact_factor_year: '2025',
    source_url: 'https://www.nature.com/example/', source_kind: 'publisher', note: 'Official journal metrics page', evidence_quote: '2025 Journal Impact Factor: 4.9',
  }],
};

test('a JIF needs its year, the matching journal and specific evidence', () => {
  const candidate = { journal: 'Example Journal', allowed_hosts: ['nature.com'] };
  const item = { journal: 'Example Journal', impact_factor: 4.9, impact_factor_year: '2025', source_kind: 'publisher', source_url: 'https://www.nature.com/example/metrics', evidence_quote: '2025 Journal Impact Factor: 4.9' };
  assert.notEqual(validateResult(item, candidate, 'now'), null);
  for (const overrides of [{ impact_factor_year: '' }, { journal: 'Another Journal' }, { source_url: 'https://www.nature.com/browse/calls-for-papers' }, { evidence_quote: '2025 CiteScore: 4.9' }, { evidence_quote: '2025 Journal Impact Factor: 9.4' }]) {
    assert.equal(validateResult({ ...item, ...overrides }, candidate, 'now'), null, JSON.stringify(overrides));
  }
});

test('metric key normalizes the ISSN', () => {
  assert.equal(metricKey({ ISSN: '1525-7797, 1526-4602' }), 'issn:15257797');
});

test('only the publisher family or Clarivate count as sources', () => {
  assert.equal(trustedSourceUrl('https://www.sciencedirect.com/journal/example', ['linkinghub.elsevier.com']), true);
  assert.equal(trustedSourceUrl('https://clarivate.com/example', []), true);
  assert.equal(trustedSourceUrl('https://academic-accelerator.example/journal', ['linkinghub.elsevier.com']), false);
});

test('a verified lookup is cached; the agent is asked read-only with web search and the schema', async () => {
  const { runner, prompts } = agent(() => '```json\n' + JSON.stringify(payload) + '\n```');
  const state: EnrichmentState = { impact_factor_cache: {} };
  const { resolved, changed } = await refreshAutomaticImpactFactors([parent], state, { settings: DEFAULT_AUTOMATIC_IMPACT_FACTOR, catalog: {}, http: noHttp, agent: runner, log: () => undefined });
  assert.equal(changed, true);
  assert.equal(resolved['issn:12345678']?.impact_factor, 4.9);
  assert.equal(state.impact_factor_cache['issn:12345678']?.status, 'found');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.options.allowWebSearch, true);
  assert.ok(prompts[0]!.options.outputSchema);
  assert.equal(prompts[0]!.options.timeoutMs, 150_000);
});

test('a fresh cache skips the agent', async () => {
  const checked = isoNow();
  const state: EnrichmentState = {
    impact_factor_cache: {
      'issn:12345678': {
        schema_version: CACHE_SCHEMA_VERSION, status: 'found', checked_at: checked, impact_factor: 4.9, impact_factor_year: '2025',
        impact_factor_source: 'https://www.nature.com/example/', impact_factor_retrieved_at: checked, impact_factor_evidence: '2025 Journal Impact Factor: 4.9',
      },
    },
  };
  const { runner, prompts } = agent(() => { throw new Error('must not be called'); });
  const { resolved, changed } = await refreshAutomaticImpactFactors([parent], state, { settings: DEFAULT_AUTOMATIC_IMPACT_FACTOR, catalog: {}, http: noHttp, agent: runner, log: () => undefined });
  assert.equal(changed, false);
  assert.equal(resolved['issn:12345678']?.impact_factor, 4.9);
  assert.equal(prompts.length, 0);
});

test('without the agent module the lookup is skipped and nothing is cached', async () => {
  const state: EnrichmentState = { impact_factor_cache: {} };
  const logs: string[] = [];
  const { changed } = await refreshAutomaticImpactFactors([parent], state, { settings: DEFAULT_AUTOMATIC_IMPACT_FACTOR, catalog: {}, http: noHttp, agent: undefined, log: message => logs.push(message) });
  assert.equal(changed, false);
  assert.deepEqual(state.impact_factor_cache, {});
  assert.ok(logs.some(line => line.includes('智能体模块未加载')));
});

test('a failed lookup keeps the previous verified value and records the error', async () => {
  const old = { schema_version: CACHE_SCHEMA_VERSION, status: 'found' as const, checked_at: '2020-01-01T00:00:00+00:00', impact_factor: 4.1, impact_factor_year: '2019', impact_factor_source: 'https://www.nature.com/x', impact_factor_retrieved_at: '2020-01-01', impact_factor_evidence: '2019 Journal Impact Factor: 4.1' };
  const state: EnrichmentState = { impact_factor_cache: { 'issn:12345678': { ...old } } };
  const { runner } = agent(() => { throw new Error('agent timed out'); });
  const { resolved, changed } = await refreshAutomaticImpactFactors([parent], state, { settings: DEFAULT_AUTOMATIC_IMPACT_FACTOR, catalog: {}, http: noHttp, agent: runner, log: () => undefined });
  assert.equal(changed, true);
  assert.equal(resolved['issn:12345678']?.impact_factor, 4.1);
  assert.equal(state.impact_factor_cache['issn:12345678']?.impact_factor, 4.1);
  assert.equal(state.impact_factor_cache['issn:12345678']?.last_error, 'agent timed out');
});

test('journals with a manual value are not looked up, and at most maxJournalsPerRun are', async () => {
  const { runner, prompts } = agent(() => JSON.stringify({ results: [] }));
  const parents = [
    { publicationTitle: 'Manual', extra: 'Impact Factor: 3.0', url: 'https://acs.org/a' },
    { publicationTitle: 'A', ISSN: '1111-1111', url: 'https://acs.org/a' },
    { publicationTitle: 'B', ISSN: '2222-2222', url: 'https://acs.org/b' },
    { publicationTitle: 'C', ISSN: '3333-3333', url: 'https://acs.org/c' },
  ];
  const state: EnrichmentState = { impact_factor_cache: {} };
  await refreshAutomaticImpactFactors(parents, state, { settings: DEFAULT_AUTOMATIC_IMPACT_FACTOR, catalog: {}, http: noHttp, agent: runner, log: () => undefined });
  assert.equal(prompts.length, 1);
  assert.deepEqual(Object.keys(state.impact_factor_cache).sort(), ['issn:11111111', 'issn:22222222']);
  assert.equal(state.impact_factor_cache['issn:11111111']?.status, 'unavailable');
});

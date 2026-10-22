import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { impactFactorFromExtra, normalizeIssn, resolveJournalMetrics } from '../../src/library/zotero/metrics';

// Port of legacy tests/test_journal_metrics.py.

test('reads impact factor, year and source from Zotero Extra', () => {
  const result = resolveJournalMetrics({
    publicationTitle: 'Biomacromolecules', ISSN: '1525-7797',
    extra: 'Impact Factor: 5.5\nImpact Factor Year: 2024\nImpact Factor Source: Journal Citation Reports',
  });
  assert.equal(result.impact_factor, 5.5);
  assert.equal(result.impact_factor_year, '2024');
  assert.equal(result.impact_factor_source, 'Journal Citation Reports');
});

test('accepts the year in the metric label', () => {
  const result = impactFactorFromExtra('JIF 2024: 9.8');
  assert.equal(result?.impact_factor, 9.8);
  assert.equal(result?.impact_factor_year, '2024');
});

test('does not substitute a five-year impact factor', () => {
  assert.equal(impactFactorFromExtra('5-year Impact Factor: 12.3'), null);
});

test('uses the catalog by journal or ISSN', () => {
  const result = resolveJournalMetrics({ publicationTitle: 'Example Journal', ISSN: '1234-5678', extra: '' }, { 12345678: { impact_factor: 4.2, year: '2025', source: 'Journal Citation Reports' } });
  assert.equal(result.impact_factor, 4.2);
  assert.equal(result.impact_factor_year, '2025');
});

test('matches one of multiple ISSNs without treating titles as ISSNs', () => {
  const result = resolveJournalMetrics({ publicationTitle: 'Example Journal', ISSN: '1525-7797, 1526-4602', extra: '' }, { 15264602: { impact_factor: 5.5, year: '2024' } });
  assert.equal(result.impact_factor, 5.5);
  assert.equal(normalizeIssn('Example Journal'), '');
});

test('returns explicit missing values', () => {
  const result = resolveJournalMetrics({ publicationTitle: 'Unknown' });
  assert.equal(result.impact_factor, null);
  assert.equal(result.impact_factor_year, '');
  assert.equal(result.impact_factor_source, '');
});

import { str } from '../text';
/** Annual Journal Impact Factor metadata, never estimated (journal_metrics.py). */

export interface ImpactFactor {
  impact_factor: number | null;
  impact_factor_year: string;
  impact_factor_source: string;
  impact_factor_retrieved_at: string;
}

export interface JournalMetrics extends ImpactFactor { journal: string; issn: string }

/** The Zotero fields the lookup reads. */
export interface JournalFields { publicationTitle?: string; journalAbbreviation?: string; ISSN?: string; extra?: string; url?: string }

/** Local fallback table, keyed by journal name, abbreviation or ISSN. */
export type ImpactFactorCatalog = Record<string, unknown>;

const FACTOR_KEYS = new Set(['if', 'jif', 'jcr if', 'jcrif', 'impact factor', 'impactfactor', 'journal impact factor', '影响因子']);
const YEAR_KEYS = new Set(['if year', 'jif year', 'impact factor year', 'impactfactor year', '影响因子年份', '影响因子年度']);
const SOURCE_KEYS = new Set(['if source', 'jif source', 'impact factor source', 'impactfactor source', '影响因子来源']);
const YEAR = /\b(?:19|20)\d{2}\b/;
const NUMBER = /(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])/;

export const EMPTY_IMPACT_FACTOR: ImpactFactor = { impact_factor: null, impact_factor_year: '', impact_factor_source: '', impact_factor_retrieved_at: '' };

export function normalizeLabel(value: unknown): string {
  return str(value ?? '').toLowerCase().trim().replace(/[_\-–—]+/g, ' ').replace(/\s+/g, ' ');
}

export function normalizeIssn(value: unknown): string {
  const normalized = str(value ?? '').replace(/[^0-9xX]/g, '').toLowerCase();
  return normalized.length === 8 ? normalized : '';
}

export function parseNumber(value: unknown): number | null {
  if (typeof value === 'boolean') return null;
  let number: number;
  if (typeof value === 'number') number = value;
  else {
    const match = NUMBER.exec(str(value ?? ''));
    if (!match) return null;
    number = Number(match[1]);
  }
  return Number.isFinite(number) && number >= 0 && number <= 1000 ? number : null;
}

export function parseYear(value: unknown): string {
  return YEAR.exec(str(value ?? ''))?.[0] ?? '';
}

function splitExtra(extra: unknown): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of str(extra ?? '').split(/\r?\n/)) {
    const match = /^\s*([^:=]+?)\s*[:=]\s*(.*?)\s*$/.exec(line);
    if (match) fields.set(normalizeLabel(match[1]), match[2]!.trim());
  }
  return fields;
}

export function impactFactorFromExtra(extra: unknown): ImpactFactor | null {
  let factor: number | null = null, year = '', source = '';
  for (const [rawKey, rawValue] of splitExtra(extra)) {
    // A five-year IF is a distinct metric, not the standard two-year JIF.
    if (rawKey.includes('5 year') || rawKey.includes('five year') || rawKey.includes('五年')) continue;
    const keyYear = parseYear(rawKey);
    const key = normalizeLabel(rawKey.replace(new RegExp(YEAR.source, 'g'), ''));
    if (FACTOR_KEYS.has(key)) {
      const candidate = parseNumber(rawValue);
      if (candidate !== null) { factor = candidate; year ||= keyYear || parseYear(rawValue); }
    } else if (YEAR_KEYS.has(key)) year = parseYear(rawValue) || year;
    else if (SOURCE_KEYS.has(key)) source = rawValue.trim();
  }
  if (factor === null) return null;
  return { impact_factor: factor, impact_factor_year: year, impact_factor_source: source || 'Zotero Extra', impact_factor_retrieved_at: '' };
}

const ISSN_IN_TEXT = /\b\d{4}-?\d{3}[\dXx]\b/g;

export function impactFactorFromCatalog(fields: JournalFields, catalog: ImpactFactorCatalog | undefined): ImpactFactor | null {
  if (!catalog || typeof catalog !== 'object') return null;
  const names = new Set([fields.publicationTitle, fields.journalAbbreviation, fields.ISSN].filter((value): value is string => !!value?.trim()).map(normalizeLabel));
  const issns = new Set((str(fields.ISSN ?? '').match(ISSN_IN_TEXT) ?? []).map(normalizeIssn).filter(Boolean));
  for (const [key, value] of Object.entries(catalog)) {
    if (!names.has(normalizeLabel(key)) && !issns.has(normalizeIssn(key))) continue;
    const record = (typeof value === 'object' && value !== null ? value : { impact_factor: value }) as Record<string, unknown>;
    const factor = parseNumber(record.impact_factor ?? record.value);
    if (factor === null) return null;
    return {
      impact_factor: factor,
      impact_factor_year: parseYear(record.impact_factor_year ?? record.year),
      impact_factor_source: str(record.impact_factor_source ?? record.source ?? '').trim() || 'Local impact-factor catalog',
      impact_factor_retrieved_at: str(record.impact_factor_retrieved_at ?? record.retrieved_at ?? '').trim(),
    };
  }
  return null;
}

/** Zotero Extra first, then the local table; missing values stay explicit. */
export function resolveJournalMetrics(fields: JournalFields, catalog?: ImpactFactorCatalog): JournalMetrics {
  const metric = impactFactorFromExtra(fields.extra) ?? impactFactorFromCatalog(fields, catalog) ?? EMPTY_IMPACT_FACTOR;
  return { journal: str(fields.publicationTitle ?? '').trim(), issn: str(fields.ISSN ?? '').trim(), ...metric };
}

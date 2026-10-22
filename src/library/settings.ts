import { DEFAULT_ZOTERO_API } from './zotero/api';
import { DEFAULT_AUTOMATIC_IMPACT_FACTOR } from './zotero/impact-factor';
import type { AutomaticImpactFactorSettings } from './zotero/impact-factor';
import type { ImpactFactorCatalog } from './zotero/metrics';
import { DEFAULT_SUPPORTING } from './zotero/supporting';
import type { SupportingSettings } from './zotero/supporting';

export type SupportingOptions = Omit<SupportingSettings, 'directory' | 'manifest'>;

export interface LibrarySettings {
  zoteroApi: string;
  collectionName: string;
  /** Resolved by name when empty or stale. */
  collectionKey: string;
  pipelinePaused: boolean;
  /**
   * The first-run question about the existing backlog: null = not asked yet; "confirmed" = process all;
   * "deferred" = only new PDFs, the listed ones wait for the backlog entry in settings.
   */
  backlog: { decision: 'confirmed' | 'deferred' | null; deferred: string[] };
  impactFactors: ImpactFactorCatalog;
  automaticImpactFactor: AutomaticImpactFactorSettings;
  supportingInformation: SupportingOptions;
  /** system/zotero-sync/config.json has been read once. */
  legacyImported: boolean;
}

export const DEFAULT_SUPPORTING_OPTIONS: SupportingOptions = {
  enabled: DEFAULT_SUPPORTING.enabled, maxFileBytes: DEFAULT_SUPPORTING.maxFileBytes,
  refreshDays: DEFAULT_SUPPORTING.refreshDays, retryDays: DEFAULT_SUPPORTING.retryDays, timeoutSeconds: DEFAULT_SUPPORTING.timeoutSeconds,
};

export function defaultSettings(): LibrarySettings {
  return {
    zoteroApi: DEFAULT_ZOTERO_API,
    collectionName: 'Doc',
    collectionKey: '',
    pipelinePaused: false,
    backlog: { decision: null, deferred: [] },
    impactFactors: {},
    automaticImpactFactor: { ...DEFAULT_AUTOMATIC_IMPACT_FACTOR },
    supportingInformation: { ...DEFAULT_SUPPORTING_OPTIONS },
    legacyImported: false,
  };
}

type Loose = Record<string, unknown>;
const record = (value: unknown): Loose => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Loose : {});
const text = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
/** Positive integer within bounds, like the Python max(lower, int(value)). */
const integer = (value: unknown, fallback: number, minimum: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.trunc(value)) : fallback);

/** Tolerates missing and malformed fields; each falls back to its default. */
export function readSettings(saved: unknown): LibrarySettings {
  const defaults = defaultSettings();
  const value = record(saved);
  const backlog = record(value.backlog);
  const automatic = record(value.automaticImpactFactor);
  const supporting = record(value.supportingInformation);
  const da = defaults.automaticImpactFactor, ds = defaults.supportingInformation;
  return {
    zoteroApi: text(value.zoteroApi, defaults.zoteroApi),
    collectionName: text(value.collectionName, defaults.collectionName),
    collectionKey: typeof value.collectionKey === 'string' ? value.collectionKey.trim() : '',
    pipelinePaused: flag(value.pipelinePaused, false),
    backlog: {
      decision: backlog.decision === 'confirmed' || backlog.decision === 'deferred' ? backlog.decision : null,
      deferred: Array.isArray(backlog.deferred) ? backlog.deferred.filter((sha): sha is string => typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha)) : [],
    },
    impactFactors: record(value.impactFactors),
    automaticImpactFactor: {
      enabled: flag(automatic.enabled, da.enabled),
      maxJournalsPerRun: integer(automatic.maxJournalsPerRun, da.maxJournalsPerRun, 1),
      openalexTimeoutSeconds: integer(automatic.openalexTimeoutSeconds, da.openalexTimeoutSeconds, 3),
      refreshDays: integer(automatic.refreshDays, da.refreshDays, 1),
      retryDays: integer(automatic.retryDays, da.retryDays, 1),
      timeoutSeconds: integer(automatic.timeoutSeconds, da.timeoutSeconds, 30),
    },
    supportingInformation: {
      enabled: flag(supporting.enabled, ds.enabled),
      maxFileBytes: integer(supporting.maxFileBytes, ds.maxFileBytes, 1024 * 1024),
      refreshDays: integer(supporting.refreshDays, ds.refreshDays, 1),
      retryDays: integer(supporting.retryDays, ds.retryDays, 1),
      timeoutSeconds: integer(supporting.timeoutSeconds, ds.timeoutSeconds, 5),
    },
    legacyImported: flag(value.legacyImported, false),
  };
}

/** Fold the Python sync's config.json into the settings (only fields that are present and valid). */
export function applyLegacyConfig(settings: LibrarySettings, config: unknown): void {
  const value = record(config);
  if (typeof value.api_base === 'string' && value.api_base.trim()) settings.zoteroApi = value.api_base.trim();
  if (typeof value.collection_name === 'string' && value.collection_name.trim()) settings.collectionName = value.collection_name.trim();
  if (typeof value.collection_key === 'string') settings.collectionKey = value.collection_key.trim();
  if (Object.keys(record(value.impact_factors)).length) settings.impactFactors = record(value.impact_factors);
  const automatic = record(value.automatic_impact_factor);
  const merged = readSettings({
    automaticImpactFactor: {
      ...settings.automaticImpactFactor,
      ...pick(automatic, { enabled: 'enabled', max_journals_per_run: 'maxJournalsPerRun', openalex_timeout_seconds: 'openalexTimeoutSeconds', refresh_days: 'refreshDays', retry_days: 'retryDays', timeout_seconds: 'timeoutSeconds' }),
    },
    supportingInformation: {
      ...settings.supportingInformation,
      ...pick(record(value.supplementary_information), { enabled: 'enabled', max_file_bytes: 'maxFileBytes', refresh_days: 'refreshDays', retry_days: 'retryDays', timeout_seconds: 'timeoutSeconds' }),
    },
  });
  settings.automaticImpactFactor = merged.automaticImpactFactor;
  settings.supportingInformation = merged.supportingInformation;
}

function pick(source: Loose, names: Record<string, string>): Loose {
  return Object.fromEntries(Object.entries(names).filter(([from]) => from in source).map(([from, to]) => [to, source[from]]));
}

export function supportingSettings(options: SupportingOptions): SupportingSettings {
  return { ...options, directory: DEFAULT_SUPPORTING.directory, manifest: DEFAULT_SUPPORTING.manifest };
}

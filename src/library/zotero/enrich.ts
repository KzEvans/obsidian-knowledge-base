import { collectionItems, resolveCollection } from './api';
import type { ZoteroApi } from './api';
import { refreshAutomaticImpactFactors } from './impact-factor';
import type { EnrichmentState, RefreshDeps } from './impact-factor';
import { compare, collectionTree } from './naming';
import { syncSupportingInformation } from './supporting';
import type { SupportingDeps } from './supporting';
import { LITERATURE_DIR, classifyItems } from './sync';

/**
 * The hourly SI / impact-factor pass (sync_zotero_doc.py --enrich). It writes only the
 * enrichment cache and the SI manifest and files; the next normal sync picks the values up.
 */
export interface EnrichDeps {
  api: ZoteroApi;
  collectionName: string;
  collectionKey: string;
  enrichment: EnrichmentState;
  saveEnrichment(state: EnrichmentState): Promise<void>;
  /** True when no enrichment cache file exists yet, so one is written. */
  enrichmentMissing: boolean;
  impactFactor: Omit<RefreshDeps, 'log'>;
  supporting: Omit<SupportingDeps, 'log' | 'attachmentPath' | 'literatureDir'>;
  log(message: string): void;
}

export async function runEnrichment(deps: EnrichDeps): Promise<{ metricsChanged: boolean; si: { available: number; downloaded: number; failed: number } }> {
  const collections = await deps.api.collections();
  const key = resolveCollection(collections, deps.collectionName, deps.collectionKey);
  const items = await collectionItems(deps.api, collectionTree(collections, key));
  const { parents, supplementary, primaryParentKeys } = classifyItems(items);
  const primaries = [...primaryParentKeys].sort(compare).flatMap(parentKey => {
    const data = parents.get(parentKey)?.data;
    return data ? [data] : [];
  });
  const log = (message: string) => deps.log(message);
  const { changed } = await refreshAutomaticImpactFactors(primaries, deps.enrichment, { ...deps.impactFactor, log });
  if (changed || deps.enrichmentMissing) await deps.saveEnrichment(deps.enrichment);
  const { stats } = await syncSupportingInformation(parents, primaryParentKeys, supplementary, {
    ...deps.supporting, literatureDir: LITERATURE_DIR, attachmentPath: attachmentKey => deps.api.attachmentPath(attachmentKey), log,
  });
  deps.log(`补全完成：影响因子变化 ${changed}，SI 可用 ${stats.available}、下载 ${stats.downloaded}、出错 ${stats.failed}`);
  return { metricsChanged: changed, si: stats };
}

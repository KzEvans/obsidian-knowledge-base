import { errorMessage } from '../../core/secrets';
import { archivePrevious, isExternalFile, sortedJson, sourceFingerprint } from '../files';
import type { VaultFiles } from '../files';
import { collectionItems, resolveCollection } from './api';
import type { ZoteroApi } from './api';
import { isoNow, metricKey, verifiedMetrics } from './impact-factor';
import type { EnrichmentState } from './impact-factor';
import { resolveJournalMetrics } from './metrics';
import type { ImpactFactor, ImpactFactorCatalog } from './metrics';
import { chooseCollection, collectionTree, compare, creatorNames, itemCollectionPaths, parentTitle, parentYear, safeFilename } from './naming';
import type { ZoteroItem } from './naming';
import { isAuxiliaryPdfAttachment, isSupplementaryPdfAttachment, parseManifest } from './supporting';

/** Mirror one Zotero collection tree into the vault (sync_zotero_doc.py without --enrich). */

export const LITERATURE_DIR = 'sources/literature';
export const PDF_DIR = `${LITERATURE_DIR}/pdf`;
export const HISTORY_DIR = `${LITERATURE_DIR}/history`;
export const MANIFEST_PATH = `${LITERATURE_DIR}/manifests/zotero-doc.json`;
export const INDEX_PATH = `${LITERATURE_DIR}/index.md`;
export const BIB_PATH = `${LITERATURE_DIR}/references.bib`;

/** One mirrored attachment; the manifest's `items` (schema_version 1, same fields as the Python sync). */
export interface SyncEntry extends ImpactFactor {
  active: boolean;
  attachment_key: string;
  attachment_version?: number | null;
  content_type?: string;
  creators: string[];
  collection_path: string;
  collection_paths: string[];
  destination: string;
  destination_name: string;
  doi: string;
  journal: string;
  issn: string;
  parent_key: string;
  previous_destinations: string[];
  sha256: string;
  source_filename: string;
  source_fingerprint: string;
  synced_at: string;
  title: string;
  url: string;
  year: string;
  zotero_select: string;
  /** Written by the old --organize-only mode; dropped from new entries. */
  generation_deferred?: boolean;
}

/** state.json: attachments by key plus bookkeeping. Unknown legacy keys are kept. */
export interface SyncState {
  attachments: Record<string, SyncEntry>;
  collection_key?: string;
  collection_name?: string;
  last_sync?: string;
  schema_version?: number;
  [legacy: string]: unknown;
}

export interface SyncDeps {
  api: ZoteroApi;
  files: VaultFiles;
  collectionName: string;
  collectionKey: string;
  catalog: ImpactFactorCatalog;
  /** null when no state has been saved yet. */
  state: SyncState | null;
  enrichment: EnrichmentState;
  saveState(state: SyncState): Promise<void>;
  log(message: string): void;
  now?: () => Date;
}

export interface SyncResult {
  collectionKey: string;
  copied: number;
  unchanged: number;
  failed: number;
  wrote: boolean;
  /** Vault paths of PDFs written this run (new or replaced). */
  copiedPaths: string[];
  /** Moves done because a paper changed collection. */
  moved: Array<{ from: string; to: string }>;
  errors: string[];
  state: SyncState;
  /** Every entry, active and inactive. */
  entries: SyncEntry[];
}

export function pdfPath(category: string, name: string): string {
  return category ? `${PDF_DIR}/${category}/${name}` : `${PDF_DIR}/${name}`;
}

/** The Zotero metadata the sync reads: primary PDFs, SI, parents. */
export function classifyItems(items: readonly ZoteroItem[]) {
  const parents = new Map(items.filter(item => item.data?.itemType !== 'attachment').map(item => [item.key, item]));
  const pdfs = items.filter(item => item.data?.itemType === 'attachment' && item.data.contentType === 'application/pdf');
  const supplementary = pdfs.filter(isSupplementaryPdfAttachment);
  const attachments = pdfs.filter(item => !isAuxiliaryPdfAttachment(item));
  const primaryParentKeys = new Set(attachments.map(item => String(item.data?.parentItem ?? '')));
  return { parents, supplementary, attachments, primaryParentKeys };
}

const same = (a: unknown, b: unknown) => sortedJson(a) === sortedJson(b);

export async function syncZotero(deps: SyncDeps): Promise<SyncResult> {
  const { api, files } = deps;
  const now = deps.now ?? (() => new Date());
  const allCollections = await api.collections();
  const collectionKey = resolveCollection(allCollections, deps.collectionName, deps.collectionKey);
  const stateExisted = deps.state !== null;
  const state: SyncState = deps.state ?? { attachments: {} };
  state.attachments ??= {};
  const paths = collectionTree(allCollections, collectionKey);
  const items = await collectionItems(api, paths);
  const { parents, attachments } = classifyItems(items);
  const automatic = verifiedMetrics(deps.enrichment);

  const syncedAt = isoNow(now());
  const previousManifestText = await files.readText(MANIFEST_PATH);
  const previousManifest = previousManifestText ? JSON.parse(previousManifestText) as { collections?: unknown; generated_at?: string } : undefined;
  let changed = !stateExisted || !previousManifest || !await files.isFile(INDEX_PATH) || !await files.isFile(BIB_PATH) || !same(previousManifest.collections, paths);
  const active: SyncEntry[] = [];
  const activeKeys = new Set<string>();
  const copiedPaths: string[] = [];
  const moved: SyncResult['moved'] = [];
  const errors: string[] = [];
  let copied = 0, unchanged = 0, failed = 0;

  for (const attachment of attachments) {
    const key = attachment.key;
    activeKeys.add(key);
    const data = attachment.data ?? {};
    const parentKey = data.parentItem ?? '';
    const parent = parents.get(parentKey);
    const parentData = parent?.data ?? {};
    const previous = state.attachments[key];
    try {
      const source = await api.attachmentPath(key);
      if (!await isExternalFile(source)) throw new Error(`Zotero 附件文件不存在：${source.split('/').pop() ?? ''}`);
      const sourceName = data.filename || source.split('/').pop() || '';
      const name = previous?.destination_name || safeFilename(sourceName, key);
      const categories = itemCollectionPaths(parent, paths);
      let category = chooseCollection(previous?.collection_path, categories);
      let destination = pdfPath(category, name);
      const fingerprint = await sourceFingerprint(source, data.md5);

      // A paper that changed collection moves (links follow) instead of being copied again.
      const old = previous?.destination;
      if (old && old !== destination && await files.isFile(old)) {
        if (!await files.isFile(destination)) {
          await files.rename(old, destination);
          moved.push({ from: old, to: destination });
          deps.log(`已随分类移动 ${key}：${old} → ${destination}`);
        } else if (await files.sha256(destination) !== previous.sha256) {
          errors.push(`${key}：目标位置已有内容不同的 PDF，未覆盖：${destination}`);
          failed++;
          category = previous.collection_path;
          destination = old;
        }
      }

      const needsCopy = !await files.isFile(destination) || previous?.source_fingerprint !== fingerprint;
      let sha: string;
      if (needsCopy) {
        if (await files.isFile(destination)) await archivePrevious(files, destination, HISTORY_DIR, previous?.sha256 ?? '');
        await files.copyIn(source, destination);
        sha = await files.sha256(destination);
        copied++;
        copiedPaths.push(destination);
        deps.log(`已复制 ${key}：${name}`);
      } else {
        sha = previous?.sha256 || await files.sha256(destination);
        unchanged++;
      }

      const metrics = resolveJournalMetrics(parentData, deps.catalog);
      if (metrics.impact_factor === null) Object.assign(metrics, automatic[metricKey(parentData)] ?? {});
      const entry: SyncEntry = {
        active: true,
        attachment_key: key,
        attachment_version: attachment.version ?? null,
        content_type: data.contentType,
        creators: creatorNames(parent),
        collection_path: category,
        collection_paths: categories,
        destination,
        destination_name: name,
        doi: parentData.DOI ?? '',
        ...metrics,
        parent_key: parentKey,
        previous_destinations: [],
        sha256: sha,
        source_filename: sourceName,
        source_fingerprint: fingerprint,
        synced_at: previous?.synced_at ?? syncedAt,
        title: parentTitle(parent),
        url: parentData.url ?? '',
        year: parentYear(parent),
        zotero_select: `zotero://select/library/items/${parentKey}`,
      };
      const oldPaths = new Set(previous?.previous_destinations ?? []);
      if (previous?.destination && previous.destination !== destination) oldPaths.add(previous.destination);
      oldPaths.delete(destination);
      entry.previous_destinations = [...oldPaths].sort(compare);
      const entryChanged = needsCopy || (Object.keys(entry) as Array<keyof SyncEntry>).some(field => field !== 'synced_at' && !same(previous?.[field] ?? null, entry[field] ?? null));
      if (entryChanged) { entry.synced_at = syncedAt; changed = true; }
      state.attachments[key] = entry;
      active.push(entry);
    } catch (error) {
      failed++;
      errors.push(`${key}：${errorMessage(error)}`);
      deps.log(`同步失败 ${key}：${errorMessage(error)}`);
    }
  }

  for (const [key, entry] of Object.entries(state.attachments)) {
    if (activeKeys.has(key)) continue;
    if (entry.active ?? true) changed = true;
    entry.active = false;
  }

  // Older source versions are kept, but follow the current paper's classification.
  const byDoi = new Map(active.filter(entry => entry.doi).map(entry => [entry.doi.trim().toLowerCase(), entry]));
  for (const entry of Object.values(state.attachments)) {
    const current = byDoi.get(String(entry.doi ?? '').trim().toLowerCase());
    if (entry.active || !current) continue;
    const category = current.collection_path;
    const old = String(entry.destination ?? '');
    const destination = pdfPath(category, entry.destination_name);
    let followed = true;
    if (old !== destination && await files.isFile(old)) {
      if (await files.isFile(destination)) {
        if (await files.sha256(destination) !== entry.sha256) {
          errors.push(`${entry.attachment_key}：分类目标位置已有内容不同的 PDF，未覆盖：${destination}`);
          failed++;
          followed = false;
        }
      } else {
        await files.rename(old, destination);
        moved.push({ from: old, to: destination });
      }
      if (followed) {
        entry.previous_destinations = [...new Set([...(entry.previous_destinations ?? []), old])].filter(value => value !== destination).sort(compare);
        entry.destination = destination;
        changed = true;
      }
    }
    if (followed && entry.collection_path !== category) {
      entry.collection_path = category;
      entry.collection_paths = current.collection_paths;
      changed = true;
    }
  }

  Object.assign(state, { collection_key: collectionKey, collection_name: deps.collectionName, last_sync: syncedAt, schema_version: 1 });
  const entries = Object.values(state.attachments).sort((a, b) => compare(a.attachment_key ?? '', b.attachment_key ?? ''));
  const manifest = { collection_key: collectionKey, collection_name: deps.collectionName, collections: paths, generated_at: syncedAt, items: entries, schema_version: 1 };

  const supporting = parseManifest(await files.readText(`${LITERATURE_DIR}/manifests/supporting-information.json`));
  const supportingByParent = new Map(supporting.items.filter(entry => (entry.active ?? true) && entry.files?.length).map(entry => [String(entry.parent_key ?? ''), entry.files]));
  const indexSyncedAt = changed ? syncedAt : String(previousManifest?.generated_at || syncedAt);
  let index = buildIndex(active, indexSyncedAt, supportingByParent);
  if (await files.readText(INDEX_PATH) !== index && !changed) {
    changed = true;
    index = buildIndex(active, syncedAt, supportingByParent);
  }

  let bibliography: string | undefined;
  try {
    const keys = [...parents.keys()].sort(compare);
    const chunks: string[] = [];
    for (let offset = 0; offset < keys.length; offset += 50) chunks.push(await api.bibtex(keys.slice(offset, offset + 50)));
    bibliography = chunks.join('\n');
    if (await files.readText(BIB_PATH) !== bibliography) changed = true;
  } catch (error) {
    deps.log(`参考文献更新推迟，保留上一版：${errorMessage(error)}`);
    if (!await files.isFile(BIB_PATH)) { failed++; errors.push(`references.bib：${errorMessage(error)}`); }
  }

  if (changed) {
    if (indexSyncedAt !== syncedAt) index = buildIndex(active, syncedAt, supportingByParent);
    if (bibliography !== undefined) await files.write(BIB_PATH, bibliography);
    await files.write(INDEX_PATH, index);
    await files.write(MANIFEST_PATH, sortedJson(manifest));
    await deps.saveState(state);
  }
  deps.log(`同步完成：分类“${deps.collectionName}”主 PDF ${attachments.length} 篇，复制 ${copied}，未变 ${unchanged}，失败 ${failed}，写入 ${changed}`);
  return { collectionKey, copied, unchanged, failed, wrote: changed, copiedPaths, moved, errors, state, entries };
}

function markdownEscape(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

export function buildIndex(entries: readonly SyncEntry[], syncedAt: string, supportingByParent: ReadonlyMap<string, ReadonlyArray<{ destination: string }>>): string {
  const lines = [
    '# Zotero Doc 文献索引', '', '> 此文件由同步程序自动生成，请勿手工编辑。', '', `最后同步：\`${syncedAt}\``, '',
    '| 分类 | 文献 | 年份 | 作者 | PDF | SI | Zotero |',
    '|---|---|---:|---|---|---|---|',
  ];
  // Python: sorted(key=(year, title), reverse=True) — stable, so ties keep their original order.
  const sorted = entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => compare(b.entry.year ?? '', a.entry.year ?? '') || compare(b.entry.title ?? '', a.entry.title ?? '') || a.index - b.index)
    .map(item => item.entry);
  for (const entry of sorted) {
    const title = markdownEscape(entry.title ?? 'Untitled');
    const year = markdownEscape(entry.year ?? '');
    const authors = markdownEscape((entry.creators ?? []).slice(0, 3).join('、'));
    const si = supportingByParent.get(String(entry.parent_key ?? '')) ?? [];
    const siLink = si.length ? `[[${si[0]!.destination}|SI]]${si.length > 1 ? ` +${si.length - 1}` : ''}` : '—';
    const category = markdownEscape((entry.collection_paths ?? []).map(value => value || 'Doc').join('、') || 'Doc');
    lines.push(`| ${category} | ${title} | ${year} | ${authors} | [[${entry.destination}|PDF]] | ${siLink} | [打开](zotero://select/library/items/${entry.parent_key}) |`);
  }
  lines.push('');
  return lines.join('\n');
}

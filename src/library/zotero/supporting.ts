import { str } from '../text';
import { createHash } from 'node:crypto';
import type { Http } from '../../core/http';
import { sha256Bytes } from '../../core/hash';
import { errorMessage } from '../../core/secrets';
import { archivePrevious, isExternalFile, sortedJson, sourceFingerprint } from '../files';
import type { VaultFiles } from '../files';
import { isoNow } from './impact-factor';
import { utf8Length } from './naming';
import type { ZoteroItem, ZoteroItemData } from './naming';

/** Supporting-information discovery and cache (supporting_information.py). SI never enters the parse pipeline. */

export interface SupportingSettings {
  enabled: boolean;
  directory: string;
  manifest: string;
  maxFileBytes: number;
  refreshDays: number;
  retryDays: number;
  timeoutSeconds: number;
}

export const DEFAULT_SUPPORTING: SupportingSettings = {
  enabled: true,
  directory: 'sources/literature/si',
  manifest: 'sources/literature/manifests/supporting-information.json',
  maxFileBytes: 100 * 1024 * 1024,
  refreshDays: 30,
  retryDays: 7,
  timeoutSeconds: 30,
};

const SUPPORTING_PHRASES = ['supporting information', 'supplementary information', 'supporting material', 'supplementary material', 'electronic supplementary material', 'supplemental information', 'supplemental material'];
const REJECT_PHRASES = ['peer review', 'review file', 'reporting summary', 'editor decision', 'author response', 'source data'];
const SUPPORTING_FILENAME_PATTERNS = [/(?:^|[_\-.])si(?:[_\-.]|\d)/i, /(?:supp|suppl|supporting|supplementary)/i, /(?:^|[_\-.])mmc\d+/i, /(?:^|[_\-.])moesm\d+/i];
const PDF_CONTENT_TYPES = new Set(['application/pdf', 'application/octet-stream', 'binary/octet-stream']);

export interface SupportingFile {
  bytes: number;
  destination: string;
  destination_name: string;
  label: string;
  sha256: string;
  source: string;
  source_url: string;
  source_fingerprint?: string;
  zotero_attachment_key?: string;
  license?: string;
  record_url?: string;
}

export interface SupportingEntry {
  active: boolean;
  checked_at: string;
  doi: string;
  errors: string[];
  files: SupportingFile[];
  next_check_after: string;
  parent_key: string;
  status: string;
  title: string;
  url: string;
}

export interface SupportingManifest { generated_at?: string; items: SupportingEntry[]; schema_version?: number }

export function normalizeDoi(value: unknown): string {
  let doi = str(value ?? '').trim();
  doi = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim();
  if (!/^10\.\d{4,9}\/\S+$/.test(doi)) return '';
  return doi.replace(/[.,;)]+$/, '').toLowerCase();
}

function safeComponent(value: unknown, fallback = 'supporting-information', maxBytes = 180): string {
  let text = str(value || fallback).split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex -- the Python sync replaces control characters too
  text = text.replace(/[\\/:*?"<>|[\]\x00-\x1f]/g, '_').replace(/\s+/g, ' ').replace(/^[ ._]+|[ ._]+$/g, '') || fallback;
  while (utf8Length(text) > maxBytes) text = [...text].slice(0, -1).join('');
  return text;
}

export function supportingFilename(sourceName: unknown, sourceId: string): string {
  const name = safeComponent(sourceName);
  const dot = name.lastIndexOf('.');
  let stem = (dot > 0 ? name.slice(0, dot) : name) || 'supporting-information';
  const suffix = ` (${safeComponent(sourceId, 'source', 60)}).pdf`;
  while (stem && utf8Length(stem + suffix) > 220) stem = [...stem].slice(0, -1).join('');
  return stem.replace(/[ ._]+$/, '') + suffix;
}

function attachmentText(data: ZoteroItemData): string {
  const tags = (data.tags ?? []).map(tag => str(tag.tag ?? '')).join(' ');
  return [data.title, data.filename, data.note].map(value => str(value ?? '')).join(' ') + ' ' + tags;
}

export function looksLikeSupportingFilename(value: unknown): boolean {
  const name = safeDecode(str(value ?? ''));
  return SUPPORTING_FILENAME_PATTERNS.some(pattern => pattern.test(name));
}

function isPdfAttachment(item: ZoteroItem): boolean {
  return item.data?.itemType === 'attachment' && item.data.contentType === 'application/pdf';
}

export function isSupplementaryPdfAttachment(item: ZoteroItem): boolean {
  if (!isPdfAttachment(item)) return false;
  const text = unescapeHtml(attachmentText(item.data!)).toLowerCase();
  if (REJECT_PHRASES.some(phrase => text.includes(phrase))) return false;
  return SUPPORTING_PHRASES.some(phrase => text.includes(phrase)) || looksLikeSupportingFilename(text);
}

/** SI and non-paper PDFs (peer review files…) that must not be mirrored as papers. */
export function isAuxiliaryPdfAttachment(item: ZoteroItem): boolean {
  if (!isPdfAttachment(item)) return false;
  const text = unescapeHtml(attachmentText(item.data!)).toLowerCase();
  return isSupplementaryPdfAttachment(item) || REJECT_PHRASES.some(phrase => text.includes(phrase));
}

export function candidateScore(url: string, label: string): number {
  const decodedUrl = safeDecode(url).toLowerCase();
  const text = `${decodedUrl} ${unescapeHtml(label).toLowerCase()}`;
  if (REJECT_PHRASES.some(phrase => text.includes(phrase))) return -100;
  let score = 0;
  if (SUPPORTING_PHRASES.some(phrase => text.includes(phrase))) score += 10;
  if (looksLikeSupportingFilename(decodedUrl)) score += 7;
  if (decodedUrl.includes('/suppl_file/') || decodedUrl.includes('downloadsupplement')) score += 7;
  if (/\.pdf(?:$|[?#])/.test(decodedUrl)) score += 3;
  if (label.toLowerCase().includes('pdf')) score += 1;
  return score;
}

export function validatePublicUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`unsupported URL: ${url.slice(0, 200)}`); }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) throw new Error(`unsupported URL: ${url.slice(0, 200)}`);
  const host = parsed.hostname.replace(/\.$/, '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('local network URL rejected');
  if (isPrivateAddress(host)) throw new Error('non-public URL rejected');
}

function isPrivateAddress(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:');
  return false;
}

/** `<a>` links with their text and title, plus `<link rel="…supp…">`, like the Python LinkCollector. */
export function collectLinks(html: string): Array<[string, string]> {
  const links: Array<[string, string]> = [];
  let anchor: { href: string; label: string[]; depth: number } | undefined;
  const token = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  for (const match of html.matchAll(token)) {
    const [, closing, rawTag, rawAttributes, text] = match;
    if (text !== undefined) { if (anchor) anchor.label.push(unescapeHtml(text)); continue; }
    if (!rawTag) continue;
    const tag = rawTag.toLowerCase();
    if (closing) {
      if (!anchor) continue;
      anchor.depth--;
      if (tag === 'a' || anchor.depth <= 0) {
        links.push([anchor.href, anchor.label.join(' ').split(/\s+/).filter(Boolean).join(' ')]);
        anchor = undefined;
      }
      continue;
    }
    const attributes = parseAttributes(rawAttributes ?? '');
    const selfClosing = /\/\s*$/.test(rawAttributes ?? '');
    if (tag === 'a' && attributes.href) anchor = { href: attributes.href, label: [attributes.title ?? '', attributes['aria-label'] ?? ''], depth: 1 };
    else if (anchor && !selfClosing && !VOID_TAGS.has(tag)) anchor.depth++;
    if (tag === 'link' && attributes.href) {
      const rel = `${attributes.rel ?? ''} ${attributes.type ?? ''}`;
      if (rel.toLowerCase().includes('supp')) links.push([attributes.href, rel]);
    }
  }
  return links;
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function parseAttributes(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of text.matchAll(/([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    result[match[1]!.toLowerCase()] = unescapeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function unescapeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

// ---- network ----

interface Candidate { source: string; source_id: string; source_url: string; record_url: string; label: string; filename: string; expected_md5: string; license: string }

export interface SiClient {
  get(url: string, maxBytes: number, accept: string): Promise<{ bytes: Uint8Array; text: string; url: string; contentType: string }>;
  postJson(url: string, payload: object, maxBytes: number): Promise<{ text: string }>;
}

/** requestUrl follows redirects itself, so only the requested URL can be checked for being public, and `url` is the requested one. */
export function createSiClient(http: Http, timeoutMs: number): SiClient {
  const request = async (url: string, maxBytes: number, accept: string, body?: string) => {
    validatePublicUrl(url);
    const response = await raceTimeout(http({ url, method: body === undefined ? 'GET' : 'POST', headers: { Accept: accept }, ...(body === undefined ? {} : { body, contentType: 'application/json' }) }), timeoutMs);
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP Error ${response.status}`);
    const bytes = new Uint8Array(response.arrayBuffer);
    if (bytes.byteLength > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
    // core's Http does not expose response headers; callers fall back to sniffing the body.
    return { bytes, text: response.text, url, contentType: '' };
  };
  return {
    get: (url, maxBytes, accept) => request(url, maxBytes, accept),
    postJson: async (url, payload, maxBytes) => ({ text: (await request(url, maxBytes, 'application/json', JSON.stringify(payload))).text }),
  };
}

async function figshareCandidates(client: SiClient, doi: string): Promise<[Candidate[], string[]]> {
  const candidates: Candidate[] = [];
  const errors: string[] = [];
  try {
    const records = JSON.parse((await client.postJson('https://api.figshare.com/v2/articles/search', { resource_doi: doi, page_size: 100 }, 4 * 1024 * 1024)).text) as Array<Record<string, unknown>>;
    for (const record of records) {
      if (normalizeDoi(record.resource_doi) !== doi) continue;
      const articleId = str(record.id ?? '');
      if (!/^\d+$/.test(articleId)) continue;
      const detailUrl = `https://api.figshare.com/v2/articles/${articleId}`;
      const detail = JSON.parse((await client.get(detailUrl, 4 * 1024 * 1024, 'application/json')).text) as Record<string, unknown>;
      const recordSignal = /\.s\d+$/i.test(str(detail.doi ?? '')) || SUPPORTING_PHRASES.some(phrase => str(detail.title ?? '').toLowerCase().includes(phrase));
      for (const file of (detail.files as Array<Record<string, unknown>> | undefined) ?? []) {
        const name = str(file.name ?? '');
        const mimetype = str(file.mimetype ?? '').toLowerCase();
        if (mimetype !== 'application/pdf' && !name.toLowerCase().endsWith('.pdf')) continue;
        if (!recordSignal && !looksLikeSupportingFilename(name)) continue;
        const downloadUrl = str(file.download_url ?? '');
        if (!downloadUrl) continue;
        candidates.push({
          source: 'figshare', source_id: `figshare-${str(file.id ?? articleId)}`, source_url: downloadUrl, record_url: detailUrl,
          label: str(detail.title ?? 'Supporting information'), filename: name,
          expected_md5: str(file.computed_md5 || file.supplied_md5 || ''), license: str((detail.license as { name?: unknown } | undefined)?.name ?? ''),
        });
      }
    }
  } catch (error) {
    errors.push(`figshare: ${errorMessage(error)}`);
  }
  return [candidates, errors];
}

async function publisherCandidates(client: SiClient, doi: string, metadataUrl: string): Promise<[Candidate[], string[]]> {
  const candidates: Candidate[] = [];
  const errors: string[] = [];
  const landing = /^https?:/i.test(metadataUrl) ? metadataUrl : `https://doi.org/${encodeURI(doi)}`;
  try {
    const response = await client.get(landing, 8 * 1024 * 1024, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1');
    if (response.contentType.toLowerCase().includes('html') || /^<(?:!doctype|html)/i.test(response.text.trimStart())) {
      for (const [href, label] of collectLinks(response.text)) {
        let candidateUrl: string;
        try { candidateUrl = new URL(unescapeHtml(href), response.url).href; } catch { continue; }
        if (candidateScore(candidateUrl, label) < 8) continue;
        const filename = safeDecode(new URL(candidateUrl).pathname).split('/').pop() || 'supporting-information.pdf';
        candidates.push({
          source: 'publisher', source_id: `publisher-${createHash('sha1').update(candidateUrl).digest('hex').slice(0, 12)}`,
          source_url: candidateUrl, record_url: response.url, label: label || 'Supporting information', filename, expected_md5: '', license: '',
        });
      }
    }
  } catch (error) {
    errors.push(`publisher ${hostOf(landing)}: ${errorMessage(error)}`);
  }
  const unique = new Map<string, Candidate>();
  for (const candidate of [...candidates].sort((a, b) => candidateScore(b.source_url, b.label) - candidateScore(a.source_url, a.label))) {
    if (!unique.has(candidate.source_url)) unique.set(candidate.source_url, candidate);
  }
  return [[...unique.values()].slice(0, 12), errors];
}

async function discoverCandidates(client: SiClient, doi: string, metadataUrl: string): Promise<[Candidate[], string[]]> {
  const [candidates, errors] = await figshareCandidates(client, doi);
  if (!candidates.length) {
    const [publisher, publisherErrors] = await publisherCandidates(client, doi, metadataUrl);
    candidates.push(...publisher);
    errors.push(...publisherErrors);
  }
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) if (!unique.has(candidate.source_url)) unique.set(candidate.source_url, candidate);
  return [[...unique.values()], errors];
}

async function pdfBytes(client: SiClient, candidate: Candidate, maxFileBytes: number): Promise<{ bytes: Uint8Array; url: string }> {
  const response = await client.get(candidate.source_url, maxFileBytes, 'application/pdf,*/*;q=0.1');
  const contentType = response.contentType.split(';')[0]!.trim().toLowerCase();
  const isPdf = startsWithPdfMagic(response.bytes);
  if (contentType && !PDF_CONTENT_TYPES.has(contentType) && !isPdf) throw new Error(`unexpected content type ${contentType}`);
  if (response.bytes.byteLength < 1024 || !isPdf) throw new Error('download is not a valid PDF');
  const expected = candidate.expected_md5.toLowerCase();
  if (expected && createHash('md5').update(response.bytes).digest('hex') !== expected) throw new Error('download MD5 does not match repository metadata');
  return { bytes: response.bytes, url: response.url };
}

export function startsWithPdfMagic(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

// ---- sync ----

export interface SupportingDeps {
  settings: SupportingSettings;
  files: VaultFiles;
  literatureDir: string;
  client: SiClient;
  attachmentPath(attachmentKey: string): Promise<string>;
  log(message: string): void;
  now?: () => Date;
}

async function validPreviousFiles(entry: SupportingEntry | undefined, files: VaultFiles): Promise<SupportingFile[]> {
  const valid: SupportingFile[] = [];
  for (const file of entry?.files ?? []) {
    const destination = str(file.destination ?? '');
    if (destination && await files.isFile(destination) && await files.size(destination) >= 1024) valid.push({ ...file });
  }
  return valid;
}

function dueForOnlineCheck(previous: SupportingEntry | undefined, doi: string, now: Date): boolean {
  if (normalizeDoi(previous?.doi) !== doi) return true;
  const next = Date.parse(previous?.next_check_after ?? '');
  return !Number.isFinite(next) || now.getTime() >= next;
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Mirror Zotero SI children and discover public SI for every primary paper. Writes only the SI manifest and files. */
export async function syncSupportingInformation(
  parents: ReadonlyMap<string, ZoteroItem>,
  mainParentKeys: Iterable<string>,
  supplementaryAttachments: readonly ZoteroItem[],
  deps: SupportingDeps,
): Promise<{ manifest: SupportingManifest; changed: boolean; stats: { available: number; downloaded: number; failed: number } }> {
  const { settings, files } = deps;
  const now = deps.now ?? (() => new Date());
  const previousManifest = parseManifest(await files.readText(settings.manifest));
  const previousByParent = new Map(previousManifest.items.filter(entry => entry.parent_key).map(entry => [str(entry.parent_key), entry]));
  if (!settings.enabled) return { manifest: previousManifest, changed: false, stats: { available: 0, downloaded: 0, failed: 0 } };

  const historyRoot = `${deps.literatureDir}/history/si`;
  const checkedNow = isoNow(now());
  const siByParent = new Map<string, ZoteroItem[]>();
  for (const attachment of supplementaryAttachments) {
    const parentKey = attachment.data?.parentItem ?? '';
    if (parentKey) siByParent.set(parentKey, [...(siByParent.get(parentKey) ?? []), attachment]);
  }

  const entries: SupportingEntry[] = [];
  let downloaded = 0, failed = 0;
  const active = new Set([...mainParentKeys].filter(Boolean));
  for (const parentKey of [...active].sort(compareText)) {
    const data = parents.get(parentKey)?.data ?? {};
    const doi = normalizeDoi(data.DOI);
    const previous = previousByParent.get(parentKey);
    let list = await validPreviousFiles(previous, files);
    const errors: string[] = [];
    const previousZotero = new Map(list.filter(file => file.zotero_attachment_key).map(file => [str(file.zotero_attachment_key), file]));

    for (const attachment of siByParent.get(parentKey) ?? []) {
      const key = attachment.key;
      const attachmentData = attachment.data ?? {};
      const old = previousZotero.get(key);
      try {
        const source = await deps.attachmentPath(key);
        if (!await isExternalFile(source)) throw new Error(`file not found: ${source.split('/').pop() ?? ''}`);
        const fingerprint = await sourceFingerprint(source, attachmentData.md5);
        const name = old?.destination_name || supportingFilename(attachmentData.filename || source.split('/').pop(), `zotero-${key}`);
        const destination = `${settings.directory}/${parentKey}/${name}`;
        if (!await files.isFile(destination) || old?.source_fingerprint !== fingerprint) {
          await archivePrevious(files, destination, `${historyRoot}/${parentKey}`, old?.sha256 ?? '');
          await files.copyIn(source, destination);
          downloaded++;
          deps.log(`SI 已从 Zotero 复制 ${key}：${name}`);
        }
        list = list.filter(file => file.zotero_attachment_key !== key);
        list.push({
          bytes: await files.size(destination), destination, destination_name: name,
          label: attachmentData.title || 'Zotero supporting information', sha256: await files.sha256(destination),
          source: 'zotero', source_fingerprint: fingerprint, source_url: `zotero://select/library/items/${key}`, zotero_attachment_key: key,
        });
      } catch (error) {
        errors.push(`zotero ${key}: ${errorMessage(error)}`);
      }
    }

    const due = !!doi && dueForOnlineCheck(previous, doi, now());
    let checkedAt = str(previous?.checked_at ?? '');
    if (due) {
      checkedAt = checkedNow;
      const [candidates, discoveryErrors] = await discoverCandidates(deps.client, doi, str(data.url ?? ''));
      errors.push(...discoveryErrors);
      const knownSources = new Set(list.map(file => str(file.source_url ?? '')));
      const knownHashes = new Set(list.map(file => str(file.sha256 ?? '')));
      for (const candidate of candidates) {
        if (knownSources.has(candidate.source_url)) continue;
        try {
          const { bytes, url } = await pdfBytes(deps.client, candidate, settings.maxFileBytes);
          const sha = await sha256Bytes(bytes);
          if (knownHashes.has(sha)) continue;
          const name = supportingFilename(candidate.filename, candidate.source_id);
          const destination = `${settings.directory}/${parentKey}/${name}`;
          if (await files.isFile(destination)) {
            const existing = await files.sha256(destination);
            if (existing !== sha) await archivePrevious(files, destination, `${historyRoot}/${parentKey}`, existing);
          }
          await files.write(destination, bytes);
          list.push({
            bytes: bytes.byteLength, destination, destination_name: name, label: candidate.label || 'Supporting information',
            license: candidate.license, record_url: candidate.record_url, sha256: sha, source: candidate.source || 'publisher', source_url: url,
          });
          knownHashes.add(sha);
          knownSources.add(candidate.source_url);
          downloaded++;
          deps.log(`SI 已下载 ${parentKey}：${name}`);
        } catch (error) {
          errors.push(`download ${candidate.source_url}: ${errorMessage(error)}`);
        }
      }
    }

    list.sort((a, b) => compareText(str(a.source ?? ''), str(b.source ?? '')) || compareText(str(a.destination ?? ''), str(b.destination ?? '')));
    let status: string, nextDays: number;
    if (list.length) { status = 'available'; nextDays = settings.refreshDays; }
    else if (!doi) { status = 'no_doi'; nextDays = settings.retryDays; }
    else if (errors.length && due) { status = 'fetch_error'; nextDays = 1; }
    else if (due) { status = 'not_found'; nextDays = settings.retryDays; }
    else { status = str(previous?.status || 'not_found'); nextDays = settings.retryDays; }
    if (errors.length) failed++;
    const base = Number.isFinite(Date.parse(checkedAt)) ? new Date(Date.parse(checkedAt)) : now();
    entries.push({
      active: true,
      checked_at: checkedAt,
      doi,
      errors: (due || errors.length ? errors : previous?.errors ?? []).slice(-8).map(error => str(error).slice(-500)),
      files: list,
      next_check_after: isoNow(new Date(base.getTime() + nextDays * 86_400_000)),
      parent_key: parentKey,
      status,
      title: str(data.title || 'Untitled'),
      url: str(data.url ?? ''),
    });
  }
  for (const [parentKey, previous] of previousByParent) {
    if (!active.has(parentKey)) entries.push({ ...previous, active: false });
  }

  const items = entries.sort((a, b) => compareText(str(a.parent_key), str(b.parent_key)));
  const core = sortedJson({ items, schema_version: 1 });
  const previousCore = sortedJson({ items: previousManifest.items, schema_version: previousManifest.schema_version ?? 1 });
  const changed = core !== previousCore || previousManifest.generated_at === undefined;
  const manifest: SupportingManifest = { items, schema_version: 1, generated_at: changed ? checkedNow : previousManifest.generated_at ?? checkedNow };
  if (changed) await files.write(settings.manifest, sortedJson(manifest));
  return {
    manifest,
    changed,
    stats: { available: items.filter(entry => entry.active && entry.files.length).length, downloaded, failed },
  };
}

export function parseManifest(text: string | undefined): SupportingManifest {
  if (!text) return { items: [] };
  const value = JSON.parse(text) as Partial<SupportingManifest>;
  return { ...value, items: Array.isArray(value.items) ? value.items : [] };
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms);
    promise.then(value => { window.clearTimeout(timer); resolve(value); }, (error: unknown) => { window.clearTimeout(timer); reject(error instanceof Error ? error : new Error(str(error))); });
  });
}

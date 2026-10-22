import path from 'node:path';
import type { Manifest } from '../../core/types';

export const LIBRARY_PDF_ROOT = 'sources/literature/pdf';
/** Written by the Zotero sync (schema_version 1, kept compatible with the Python version). */
export const ZOTERO_MANIFEST = 'sources/literature/manifests/zotero-doc.json';
export const SUPPORTING_MANIFEST = 'sources/literature/manifests/supporting-information.json';
export const PURPOSE_PATH = 'system/knowledge/purpose.md';
export const PAPERS_ROOT = 'wiki/papers';

export interface PaperMetadata {
  title: string;
  creators: string[];
  year: string;
  journal: string;
  issn: string;
  doi: string;
  url: string;
  zoteroItem: string;
  zoteroAttachment: string;
  impactFactor: number | null;
  impactFactorYear: string;
  impactFactorSource: string;
  impactFactorRetrievedAt: string;
  /** Vault path of the PDF the note links to. */
  sourcePdf: string;
  /** Folder below wiki/papers; '' for the root. */
  collectionPath: string;
  supportingInformation: string[];
}

type Json = Record<string, unknown>;

/**
 * Bibliographic data for one stored paper: the Zotero manifest entry for its attachment key
 * (or sha), falling back to the PDF file name for papers outside the library.
 */
export async function paperMetadata(manifest: Manifest, readText: (vaultPath: string) => Promise<string | null>): Promise<PaperMetadata> {
  const source = manifest.sources.find(item => item.inLibrary && item.path.startsWith(LIBRARY_PDF_ROOT + '/')) ?? manifest.sources[0];
  if (!source) throw new Error('这篇论文没有记录 PDF 路径。');
  const items = arrayOf(parse(await readText(ZOTERO_MANIFEST)).items);
  const entry = items.find(item => item.active !== false && source.zoteroAttachmentKey && item.attachment_key === source.zoteroAttachmentKey)
    ?? items.find(item => item.active !== false && item.sha256 === manifest.sha256)
    ?? {};
  const parentKey = text(entry.parent_key) || source.zoteroParentKey || '';
  const supporting = arrayOf(parse(await readText(SUPPORTING_MANIFEST)).items)
    .find(item => item.active !== false && parentKey && item.parent_key === parentKey);
  const impact = entry.impact_factor;
  return {
    title: plainTitle(text(entry.title) || path.basename(source.path, path.extname(source.path))),
    creators: Array.isArray(entry.creators) ? entry.creators.map(String).filter(Boolean) : [],
    year: text(entry.year),
    journal: text(entry.journal),
    issn: text(entry.issn),
    doi: text(entry.doi),
    url: text(entry.url),
    zoteroItem: parentKey,
    zoteroAttachment: text(entry.attachment_key) || source.zoteroAttachmentKey || '',
    impactFactor: typeof impact === 'number' && Number.isFinite(impact) ? impact : null,
    impactFactorYear: text(entry.impact_factor_year),
    impactFactorSource: text(entry.impact_factor_source),
    impactFactorRetrievedAt: text(entry.impact_factor_retrieved_at),
    sourcePdf: source.path,
    collectionPath: collectionPath(source.inLibrary ? source.path : ''),
    supportingInformation: arrayOf(supporting?.files).map(file => text(file.destination)).filter(Boolean),
  };
}

/** `sources/literature/pdf/A/B/x.pdf` → `A/B`; anything outside the library goes to the root. */
export function collectionPath(pdfPath: string): string {
  if (!pdfPath.startsWith(LIBRARY_PDF_ROOT + '/')) return '';
  const folder = path.posix.dirname(pdfPath.slice(LIBRARY_PDF_ROOT.length + 1));
  if (folder === '.') return '';
  const parts = folder.split('/');
  if (parts.some(part => !part || part === '..' || part === '.') || parts[0] === 'images' || parts[0] === 'close-reading') {
    throw new Error(`文献库路径无法对应笔记目录：${folder}`);
  }
  return folder;
}

export interface NoteIdentity { displayTitle: string; notePath: string }

/** `YYYY-MM-DD - 第一作者 - 标题` in `wiki/papers/<collection-path>/`. */
export function noteIdentity(metadata: PaperMetadata, generatedDate: string): NoteIdentity {
  const firstAuthor = metadata.creators[0]?.trim() || 'Unknown author';
  const displayTitle = `${generatedDate} - ${firstAuthor} - ${metadata.title}`;
  const stem = safeStem(displayTitle, 220);
  return { displayTitle, notePath: path.posix.join(PAPERS_ROOT, metadata.collectionPath, `${stem}.md`) };
}

export function safeStem(value: string, maxBytes = 160): string {
  // eslint-disable-next-line no-control-regex -- control characters are not allowed in file names
  let stem = value.replace(/[\\/:*?"<>|[\]\x00-\x1f]/g, '_').replace(/\s+/g, ' ').replace(/^[ ._]+|[ ._]+$/g, '') || 'Untitled';
  while (Buffer.byteLength(stem, 'utf8') > maxBytes) stem = [...stem].slice(0, -1).join('');
  return stem;
}

const SUBSCRIPT: Record<string, string> = Object.fromEntries([...'0123456789+-=()'].map((char, index) => [char, '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎'[index]!]));
const SUPERSCRIPT: Record<string, string> = Object.fromEntries([...'0123456789+-=()'].map((char, index) => [char, '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾'[index]!]));

/** Zotero title markup to plain text (sub/superscript digits become Unicode). */
export function plainTitle(value: string): string {
  const script = (map: Record<string, string>) => (_: string, inner: string) => [...inner.replace(/<[^>]+>/g, '')].map(char => map[char] ?? char).join('');
  const result = unescapeHtml(value
    .replace(/<sub>([\s\S]*?)<\/sub>/gi, script(SUBSCRIPT))
    .replace(/<sup>([\s\S]*?)<\/sup>/gi, script(SUPERSCRIPT))
    .replace(/<[^>]+>/g, ''));
  return result.replace(/\s+/g, ' ').trim() || 'Untitled';
}

export function localDate(date = new Date()): string {
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** ISO time with the local offset, like the Python runner wrote. */
export function localIso(date = new Date()): string {
  const pad = (number: number) => String(number).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

function unescapeHtml(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
    return named[code.toLowerCase()] ?? entity;
  });
}

function parse(textValue: string | null): Json {
  if (!textValue) return {};
  try { const value: unknown = JSON.parse(textValue); return typeof value === 'object' && value !== null ? value as Json : {}; }
  catch { return {}; }
}

function arrayOf(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => typeof item === 'object' && item !== null) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

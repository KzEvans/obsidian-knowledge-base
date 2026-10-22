/** Folder and file naming rules from sync_zotero_doc.py, kept byte-compatible with the Python sync. */

export interface ZoteroCollection { key: string; data?: { name?: unknown; parentCollection?: unknown } }

export interface ZoteroItem {
  key: string;
  version?: number;
  data?: ZoteroItemData;
}

export interface ZoteroItemData {
  itemType?: string;
  contentType?: string;
  parentItem?: string;
  filename?: string;
  title?: string;
  note?: string;
  md5?: string | null;
  collections?: string[];
  creators?: Array<{ name?: string; firstName?: string; lastName?: string }>;
  date?: string;
  DOI?: string;
  url?: string;
  extra?: string;
  publicationTitle?: string;
  journalAbbreviation?: string;
  ISSN?: string;
  tags?: Array<{ tag?: string }>;
}

// eslint-disable-next-line no-control-regex -- the Python sync replaces control characters too
const FOLDER_UNSAFE = /[\\/:*?"<>|[\]#\x00-\x1f]/g;
// eslint-disable-next-line no-control-regex -- the Python sync replaces control characters too
const FILE_UNSAFE = /[\\/:*?"<>|[\]\x00-\x1f]/g;
const RESERVED_ROOT_FOLDERS = new Set(['images', 'close-reading']);
const encoder = new TextEncoder();

export function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Drop trailing code points until the UTF-8 length fits. */
function truncateBytes(text: string, maxBytes: number): string {
  let result = text;
  while (result && utf8Length(result) > maxBytes) result = [...result].slice(0, -1).join('');
  return result;
}

/** Python's str.strip(chars) for a fixed character set. */
function stripChars(text: string, chars: string): string {
  let start = 0, end = text.length;
  while (start < end && chars.includes(text[start]!)) start++;
  while (end > start && chars.includes(text[end - 1]!)) end--;
  return text.slice(start, end);
}

function rstripChars(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/** Map the configured collection and all descendants to safe relative folders ("" is the root). */
export function collectionTree(collections: readonly ZoteroCollection[], rootKey: string): Record<string, string> {
  const paths: Record<string, string> = { [rootKey]: '' };
  const remaining = new Map(collections.filter(item => item.key !== rootKey).map(item => [item.key, item.data ?? {}]));
  while (remaining.size) {
    const children = [...remaining].filter(([, data]) => typeof data.parentCollection === 'string' && data.parentCollection in paths);
    if (!children.length) break;
    const names = new Map<string, string>();
    for (const [key, data] of children) {
      const raw = typeof data.name === 'string' && data.name ? data.name : key;
      let name = stripChars(raw.replace(FOLDER_UNSAFE, '_'), ' .') || key;
      name = truncateBytes(name, 150);
      if (!paths[data.parentCollection as string] && RESERVED_ROOT_FOLDERS.has(name.toLowerCase())) name += ` (${key})`;
      names.set(key, name);
    }
    for (const [key, data] of children) {
      let name = names.get(key)!;
      const parent = data.parentCollection as string;
      const siblings = children.filter(([other, otherData]) => otherData.parentCollection === parent && names.get(other)!.toLowerCase() === name.toLowerCase());
      if (siblings.length > 1) name += ` (${key})`;
      const parentPath = paths[parent]!;
      paths[key] = parentPath ? `${parentPath}/${name}` : name;
      remaining.delete(key);
    }
  }
  return paths;
}

function depth(collectionPath: string): number {
  return collectionPath ? collectionPath.split('/').length : 0;
}

/** Every collection folder of a paper, deepest first, then by case-folded name. */
export function itemCollectionPaths(parent: ZoteroItem | undefined, paths: Record<string, string>): string[] {
  const selected = new Set((parent?.data?.collections ?? []).filter(key => key in paths).map(key => paths[key]!));
  const list = selected.size ? [...selected] : [''];
  return list.sort((a, b) => depth(b) - depth(a) || compare(a.toLowerCase(), b.toLowerCase()) || compare(a, b));
}

/**
 * Keep the previous folder while it is still one of the paper's collections and no
 * deeper one exists; otherwise move to the deepest.
 */
export function chooseCollection(previous: string | undefined, categories: readonly string[]): string {
  const deepest = categories[0] ?? '';
  if (previous === undefined || !categories.includes(previous) || depth(previous) < depth(deepest)) return deepest;
  return previous;
}

export function safeFilename(sourceName: string, attachmentKey: string): string {
  const base = sourceName.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  let stem = (dot > 0 ? base.slice(0, dot) : base) || 'document';
  stem = stripChars(stem.replace(FILE_UNSAFE, '_').replace(/\s+/g, ' '), ' ._') || 'document';
  const suffix = ` (${attachmentKey}).pdf`;
  while (stem && utf8Length(stem + suffix) > 220) stem = [...stem].slice(0, -1).join('');
  return rstripChars(stem, ' ._') + suffix;
}

export function parentTitle(parent: ZoteroItem | undefined): string {
  return parent?.data?.title || 'Untitled';
}

export function parentYear(parent: ZoteroItem | undefined): string {
  return /\b(19|20)\d{2}\b/.exec(parent?.data?.date ?? '')?.[0] ?? '';
}

export function creatorNames(parent: ZoteroItem | undefined): string[] {
  return (parent?.data?.creators ?? []).flatMap(creator => {
    const name = creator.name || [creator.firstName ?? '', creator.lastName ?? ''].filter(Boolean).join(' ');
    return name ? [name] : [];
  });
}

/** Python's default string ordering: by code point. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

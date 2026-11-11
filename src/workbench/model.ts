/** The library as the workbench shows it: Zotero manifest items joined with their paper notes. Pure, no Obsidian. */

export const MANIFEST_PATH = 'sources/literature/manifests/zotero-doc.json';
export const NOTES_ROOT = 'wiki/papers';
/** Folders under wiki/papers that hold images or reading drafts, not paper notes. */
const NOT_NOTES = [`${NOTES_ROOT}/images/`, `${NOTES_ROOT}/close-reading/`];

export type NoteState = 'none' | 'draft' | 'reviewed';

export interface NoteInfo {
  path: string;
  attachment?: string;
  sha256?: string;
  doi?: string;
  /** The note's `source_pdf`, already resolved to a vault path. */
  pdfPath?: string;
  reviewed: boolean;
}

export interface Paper {
  key: string;
  title: string;
  authors: string[];
  year: string;
  journal: string;
  impactFactor: number | null;
  /** Zotero collection path below the Doc collection; '' for papers at its root. */
  collection: string;
  pdfPath: string;
  notePath?: string;
  state: NoteState;
  zoteroSelect?: string;
}

interface ManifestItem {
  key: string;
  pdfPath: string;
  title: string;
  authors: string[];
  year: string;
  journal: string;
  impactFactor: number | null;
  collection: string;
  doi: string;
  sha256: string;
  zoteroSelect?: string;
}

const str = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Active PDF items of `zotero-doc.json`; anything malformed is skipped. */
export function parseManifest(json: unknown): ManifestItem[] {
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const result: ManifestItem[] = [];
  for (const raw of items as Array<Record<string, unknown>>) {
    const pdfPath = str(raw.destination);
    if (raw.active !== true || !pdfPath.toLowerCase().endsWith('.pdf') || !str(raw.attachment_key)) continue;
    result.push({
      key: str(raw.attachment_key),
      pdfPath,
      title: str(raw.title).replace(/<[^>]+>/g, '') || pdfPath.split('/').pop()!.replace(/\.pdf$/i, ''),
      authors: Array.isArray(raw.creators) ? raw.creators.filter((name): name is string => typeof name === 'string') : [],
      year: str(raw.year),
      journal: str(raw.journal),
      impactFactor: typeof raw.impact_factor === 'number' ? raw.impact_factor : null,
      collection: str(raw.collection_path),
      doi: str(raw.doi).toLowerCase(),
      sha256: str(raw.sha256),
      zoteroSelect: str(raw.zotero_select) || undefined,
    });
  }
  return result;
}

/** A paper note: `type: paper` under wiki/papers, outside the image and close-reading folders. */
export function noteInfo(path: string, frontmatter: Record<string, unknown> | undefined, resolvePdf: (link: string) => string | undefined): NoteInfo | undefined {
  if (!path.startsWith(`${NOTES_ROOT}/`) || NOT_NOTES.some(prefix => path.startsWith(prefix)) || frontmatter?.type !== 'paper') return undefined;
  const link = str(frontmatter.source_pdf).replace(/^\[\[|\]\]$/g, '').split(/[|#]/)[0]!.trim();
  return {
    path,
    attachment: str(frontmatter.zotero_attachment) || undefined,
    sha256: str(frontmatter.source_sha256) || undefined,
    doi: str(frontmatter.doi).toLowerCase() || undefined,
    pdfPath: link ? resolvePdf(link) : undefined,
    reviewed: frontmatter.reviewed === true || frontmatter.status === 'reviewed',
  };
}

/** A note belongs to a paper by attachment key, then PDF path, file hash, and DOI (an older attachment of the same paper). */
export function buildPapers(json: unknown, notes: readonly NoteInfo[]): Paper[] {
  return parseManifest(json).map(item => {
    const note = notes.find(n => n.attachment === item.key)
      ?? notes.find(n => n.pdfPath === item.pdfPath)
      ?? notes.find(n => !!item.sha256 && n.sha256 === item.sha256)
      ?? notes.find(n => !!item.doi && n.doi === item.doi);
    return {
      key: item.key, title: item.title, authors: item.authors, year: item.year, journal: item.journal,
      impactFactor: item.impactFactor, collection: item.collection, pdfPath: item.pdfPath, zoteroSelect: item.zoteroSelect,
      notePath: note?.path, state: note ? (note.reviewed ? 'reviewed' : 'draft') : 'none',
    };
  });
}

/** Note ⇄ PDF for paired reading, including notes whose paper has left the manifest. */
export function pairIndex(papers: readonly Paper[], notes: readonly NoteInfo[]): { pdfFor: Map<string, string>; noteFor: Map<string, string> } {
  const pdfFor = new Map<string, string>();
  const noteFor = new Map<string, string>();
  for (const note of notes) if (note.pdfPath) pdfFor.set(note.path, note.pdfPath);
  for (const paper of papers) {
    if (!paper.notePath) continue;
    if (!pdfFor.has(paper.notePath)) pdfFor.set(paper.notePath, paper.pdfPath);
    noteFor.set(paper.pdfPath, paper.notePath);
  }
  for (const [note, pdf] of pdfFor) if (!noteFor.has(pdf)) noteFor.set(pdf, note);
  return { pdfFor, noteFor };
}

export interface CollectionNode {
  name: string;
  /** '' is the Doc root itself, shown as 未分类. */
  path: string;
  /** Papers here and in every subcollection. */
  count: number;
  children: CollectionNode[];
}

export const UNFILED = '未分类';
const byName = (a: CollectionNode, b: CollectionNode) => a.name.localeCompare(b.name, 'zh-Hans-CN');

export function collectionTree(papers: readonly Paper[]): CollectionNode[] {
  const roots: CollectionNode[] = [];
  let unfiled = 0;
  for (const paper of papers) {
    if (!paper.collection) { unfiled++; continue; }
    let level = roots;
    let path = '';
    for (const name of paper.collection.split('/')) {
      path = path ? `${path}/${name}` : name;
      let node = level.find(n => n.name === name);
      if (!node) level.push(node = { name, path, count: 0, children: [] });
      node.count++;
      level = node.children;
    }
  }
  const sort = (nodes: CollectionNode[]) => { nodes.sort(byName); nodes.forEach(n => sort(n.children)); };
  sort(roots);
  if (unfiled) roots.push({ name: UNFILED, path: '', count: unfiled, children: [] });
  return roots;
}

export interface Filter {
  /** null: every paper; '': only the Doc root; otherwise the collection and its subcollections. */
  collection: string | null;
  query: string;
  state: NoteState | 'all';
}

export function inCollection(paper: Paper, collection: string | null): boolean {
  if (collection === null) return true;
  if (collection === '') return paper.collection === '';
  return paper.collection === collection || paper.collection.startsWith(`${collection}/`);
}

export function filterPapers(papers: readonly Paper[], filter: Filter): Paper[] {
  const terms = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  return papers.filter(paper => {
    if (!inCollection(paper, filter.collection) || (filter.state !== 'all' && paper.state !== filter.state)) return false;
    const text = `${paper.title} ${paper.authors.join(' ')} ${paper.journal} ${paper.year}`.toLowerCase();
    return terms.every(term => text.includes(term));
  });
}

export type Column = 'title' | 'author' | 'year' | 'journal' | 'impactFactor' | 'state';
const STATE_ORDER: Record<NoteState, number> = { none: 0, draft: 1, reviewed: 2 };

/** Empty values sort last in both directions. */
export function sortPapers(papers: readonly Paper[], column: Column, descending: boolean): Paper[] {
  const value = (paper: Paper): string | number | null => {
    switch (column) {
      case 'title': return paper.title || null;
      case 'author': return paper.authors[0] ?? null;
      case 'year': return paper.year ? Number(paper.year) || paper.year : null;
      case 'journal': return paper.journal || null;
      case 'impactFactor': return paper.impactFactor;
      case 'state': return STATE_ORDER[paper.state];
    }
  };
  return [...papers].sort((a, b) => {
    const x = value(a), y = value(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-Hans-CN');
    return descending ? -order : order;
  });
}

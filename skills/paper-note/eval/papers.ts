/** The evaluation set, by Zotero attachment key (no paper content lives in the repo). */
export const EVAL_PAPERS = [
  { key: '45E67PNV', label: 'Duraivel 2026, Macromolecules' },
  { key: '3TZSESHQ', label: 'Meng 2016' },
  { key: '3Y45NZ44', label: 'Chen 2021' },
] as const;

/** One entry of the vault's sources/literature/manifests/zotero-doc.json (fields used here). */
export interface ZoteroItem {
  attachment_key: string;
  sha256: string;
  destination: string;
  title: string;
  creators: unknown;
  year: string;
  journal: string;
  doi: string;
}

/** Top-level `key: value` pairs of a note's frontmatter, quotes removed. */
export function readFrontmatter(markdown: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown);
  const fields: Record<string, string> = {};
  for (const line of match?.[1]?.split('\n') ?? []) {
    const field = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!] = field[2]!.replace(/^"(.*)"$/, '$1');
  }
  return fields;
}

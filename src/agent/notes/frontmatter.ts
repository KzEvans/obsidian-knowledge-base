/** Line-level frontmatter handling that leaves every other line of the note untouched. */

export type FieldValue = string | number | boolean | null | readonly string[];

/** Same style as the existing notes: JSON-quoted strings, inline JSON arrays. */
export function yamlValue(value: FieldValue): string {
  return value === null || value === '' ? 'null' : JSON.stringify(value);
}

export function buildFrontmatter(fields: readonly (readonly [string, FieldValue])[]): string {
  return ['---', ...fields.map(([key, value]) => `${key}: ${yamlValue(value)}`), '---'].join('\n');
}

/** `frontmatter` is the text between the fences, or null when the note has none. */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? { frontmatter: match[1]!, body: text.slice(match[0].length) } : { frontmatter: null, body: text };
}

/** A scalar field with surrounding quotes removed; undefined when absent. */
export function readScalar(frontmatter: string, key: string): string | undefined {
  const match = new RegExp(`^${escapeRegExp(key)}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(frontmatter);
  if (!match) return undefined;
  const raw = match[1]!;
  if (raw.startsWith('"')) { try { return String(JSON.parse(raw)); } catch { return raw.slice(1, -1); } }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

/** Inline (`[a, "b"]`) or block (`- a`) list of strings. */
export function readList(frontmatter: string, key: string): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const index = lines.findIndex(line => new RegExp(`^${escapeRegExp(key)}:`).test(line));
  if (index < 0) return [];
  const inline = lines[index]!.slice(key.length + 1).trim();
  if (inline.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(inline);
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean);
    } catch { /* YAML flow list without quotes */ }
    return inline.slice(1, -1).split(',').map(item => unquote(item.trim())).filter(Boolean);
  }
  if (inline) return [];
  const items: string[] = [];
  for (const line of lines.slice(index + 1)) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (!item) break;
    const value = unquote(item[1]!.trim());
    if (value) items.push(value);
  }
  return items;
}

/** Replace or add one top-level scalar, creating the frontmatter when missing. */
export function upsertFrontmatterField(text: string, key: string, value: FieldValue): string {
  const line = `${key}: ${yamlValue(value)}`;
  const lines = text.split('\n');
  if (lines[0]?.trimEnd() !== '---') return ['---', line, '---', '', ...lines].join('\n');
  const closing = lines.findIndex((candidate, index) => index > 0 && candidate.trimEnd() === '---');
  if (closing < 0) return text;
  const pattern = new RegExp(`^${escapeRegExp(key)}:`);
  const existing = lines.findIndex((candidate, index) => index > 0 && index < closing && pattern.test(candidate));
  if (existing >= 0) lines[existing] = line;
  else lines.splice(closing, 0, line);
  return lines.join('\n');
}

/** draft ⇄ reviewed; `reviewed` always follows `status`. */
export function setReviewStatus(text: string, reviewed: boolean): string {
  return upsertFrontmatterField(upsertFrontmatterField(text, 'status', reviewed ? 'reviewed' : 'draft'), 'reviewed', reviewed);
}

export function isReviewed(text: string): boolean {
  const { frontmatter } = splitFrontmatter(text);
  return frontmatter !== null && readScalar(frontmatter, 'status') === 'reviewed';
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) { try { return String(JSON.parse(value)); } catch { return value.slice(1, -1); } }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

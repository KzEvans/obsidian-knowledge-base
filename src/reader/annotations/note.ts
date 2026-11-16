/**
 * The two human sections of a paper note that the reader maintains (contracts §7):
 *
 *   ## 我的理解      free writing, edited in Obsidian
 *   ## 段落批注      one entry per annotated paragraph, in paper order:
 *
 *   > [!quote] [[paper.pdf#page=3|p.3]] %%pw:7f3a9c12e0b4%%
 *   > The glass transition temperature shifts upward when …
 *
 *   The reader's own words, any Markdown.
 *
 * `pw:` holds the first 12 hex digits of the paragraph's segment sourceHash, which stays the
 * same across normalizer upgrades while the paragraph text is unchanged. Everything here is
 * pure string work so it can run inside vault.process().
 */

export const OWN_HEADING = '我的理解';
export const ANNOTATION_HEADING = '段落批注';
export const ANCHOR_LENGTH = 12;
const QUOTE_LENGTH = 100;
const ENTRY_START = /^> \[!quote\][^\n]*%%pw:([0-9a-f]{12})%%\s*$/;

export interface NoteAnnotation {
  id: string;
  /** The quoted paper text as written in the note, without a trailing ellipsis. */
  quote: string;
  body: string;
}

export interface NewAnnotation {
  /** A full or abbreviated segment sourceHash. */
  anchor: string;
  /** A Markdown link to the source page, e.g. [[paper.pdf#page=3|p.3]]. */
  link: string;
  /** English source text of the paragraph. */
  text: string;
  body: string;
}

interface Heading { line: number; level: number; text: string }
interface Entry extends NoteAnnotation { start: number; end: number }
interface Section { start: number; end: number; entries: Entry[] }

export function anchorId(hash: string): string { return hash.slice(0, ANCHOR_LENGTH); }

export function parseAnnotations(note: string): NoteAnnotation[] {
  const lines = note.split('\n');
  return (section(lines)?.entries ?? []).map(({ id, quote, body }) => ({ id, quote, body }));
}

/**
 * Write or replace the entry for `annotation`; an empty body removes it. `replaces` names an
 * older entry id (found by its quote after a re-parse) that this one supersedes. A new entry
 * goes before the first entry that comes later in the paper; `order` gives an entry id's
 * place in reading order, or undefined when the paragraph is no longer in the paper.
 */
export function writeAnnotation(note: string, annotation: NewAnnotation, order: (id: string) => number | undefined, replaces?: string): string {
  const id = anchorId(annotation.anchor);
  const body = annotation.body.trim();
  const lines = note.split('\n');
  let found = section(lines);
  const existing = found?.entries.find(entry => entry.id === id) ?? (replaces ? found?.entries.find(entry => entry.id === replaces) : undefined);
  if (!body) {
    if (!found || !existing) return note;
    lines.splice(existing.start, existing.end - existing.start);
    return finish(lines);
  }
  const block = entryLines(id, annotation.link, annotation.text, body);
  if (existing) {
    // An entry's range runs to the next entry, so it owns the blank line after it.
    lines.splice(existing.start, existing.end - existing.start, ...block, '');
    return finish(lines);
  }
  if (!found) {
    createSection(lines);
    found = section(lines)!;
  }
  const place = order(id);
  const before = place === undefined ? undefined : found.entries.find(entry => (order(entry.id) ?? -1) > place);
  if (before) {
    const gap = before.start > 0 && lines[before.start - 1]!.trim() ? [''] : [];
    lines.splice(before.start, 0, ...gap, ...block, '');
  } else {
    const at = trimBack(lines, found.end, found.start);
    lines.splice(at, 0, '', ...block);
  }
  return finish(lines);
}

function entryLines(id: string, link: string, text: string, body: string): string[] {
  return [`> [!quote] ${link} %%pw:${id}%%`, `> ${quoteText(text)}`, '', body];
}

/** One line of the paper text, short enough to scan; `%%` would open an Obsidian comment. */
export function quoteText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').replace(/%%/g, '%').trim();
  if (flat.length <= QUOTE_LENGTH) return flat;
  let cut = flat.slice(0, QUOTE_LENGTH);
  // Never stop inside a formula or a tag: an unclosed `$` or `<sup` would swallow the rest of the callout.
  if ((cut.match(/(?<!\\)\$/g)?.length ?? 0) % 2) cut = cut.slice(0, cut.lastIndexOf('$'));
  if (cut.lastIndexOf('<') > cut.lastIndexOf('>')) cut = cut.slice(0, cut.lastIndexOf('<'));
  return `${cut.trimEnd()}…`;
}

/** Whether `quote` (from the note) was taken from `text` (a paragraph of the current document). */
export function quoteMatches(quote: string, text: string): boolean {
  const flat = text.replace(/\s+/g, ' ').replace(/%%/g, '%').trim();
  return Boolean(quote) && (flat === quote || (quote.length >= 20 && flat.startsWith(quote)));
}

/** `## 我的理解` then `## 段落批注`, after the AI body and before the first human block or `# 提问`. */
function createSection(lines: string[]): void {
  const headings = markdownHeadings(lines);
  const own = headings.findIndex(heading => heading.level === 2 && heading.text === OWN_HEADING);
  if (own >= 0) {
    const next = headings.slice(own + 1).find(heading => heading.level <= 2);
    const at = trimBack(lines, next ? next.line : lines.length);
    lines.splice(at, 0, '', `## ${ANNOTATION_HEADING}`);
    return;
  }
  const human = headings.find((heading, index) => (heading.level === 1 && index > 0) || HUMAN_HEADINGS.has(heading.text));
  const at = trimBack(lines, human ? human.line : lines.length);
  lines.splice(at, 0, '', `## ${OWN_HEADING}`, '', `## ${ANNOTATION_HEADING}`);
}

const HUMAN_HEADINGS = new Set(['人工复核', 'Human Review', '提问']);

function section(lines: string[]): Section | undefined {
  const headings = markdownHeadings(lines);
  const index = headings.findIndex(heading => heading.level === 2 && heading.text === ANNOTATION_HEADING);
  if (index < 0) return undefined;
  const start = headings[index]!.line + 1;
  const end = headings.slice(index + 1).find(heading => heading.level <= 2)?.line ?? lines.length;
  const starts: Array<{ line: number; id: string }> = [];
  for (let line = start; line < end; line++) {
    const match = ENTRY_START.exec(lines[line]!);
    if (match) starts.push({ line, id: match[1]! });
  }
  const entries = starts.map(({ line, id }, position) => {
    const stop = starts[position + 1]?.line ?? end;
    let bodyStart = line + 1;
    while (bodyStart < stop && lines[bodyStart]!.startsWith('>')) bodyStart++;
    const quote = lines.slice(line + 1, bodyStart).map(text => text.replace(/^>\s?/, '')).join(' ').trim().replace(/…$/, '');
    return { id, quote, body: lines.slice(bodyStart, stop).join('\n').trim(), start: line, end: stop };
  });
  return { start, end, entries };
}

function trimBack(lines: string[], at: number, floor = 0): number {
  while (at > floor && !lines[at - 1]!.trim()) at--;
  return at;
}

/** The note keeps ending with a newline. */
function finish(lines: string[]): string {
  if (lines.at(-1)?.trim()) lines.push('');
  return lines.join('\n');
}

/** ATX headings outside fenced code (the agent keeps its own copy; modules do not share code). */
function markdownHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let fence: { marker: string; length: number } | undefined;
  lines.forEach((line, number) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { marker: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
    } else if (!fence) {
      const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*\r?$/.exec(line);
      if (heading) headings.push({ line: number, level: heading[1]!.length, text: heading[2]! });
    }
  });
  return headings;
}

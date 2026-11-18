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
/** An entry's first line (contracts §7). */
const ENTRY_START = /^> \[!quote\][^\n]*%%pw:([0-9a-f]{12})%%\s*$/;
/** A first line whose marker was edited: still a closed `%%pw:…%%`, or the generated page link followed by what is left of one. */
const DAMAGED_START = /^> \[!quote\](?:[^\n]*%%pw:([^%\n]*)%%\s*$| (?:\[\[[^\]\n]+\]\]|\[[^\]\n]*\]\([^)\n]*\))\s*%{1,2}pw:([^\n]*)$)/;

export interface NoteAnnotation {
  id: string;
  /** The quoted paper text as written in the note, without a trailing ellipsis. */
  quote: string;
  body: string;
  /** The `pw:` marker was edited into something that is not an anchor; the entry is kept as written and never placed. */
  broken?: true;
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
  return (section(lines)?.entries ?? []).map(({ id, quote, body, broken }) => ({ id, quote, body, ...(broken ? { broken } : {}) }));
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
  const entries = found?.entries.filter(entry => !entry.broken) ?? [];
  const existing = entries.find(entry => entry.id === id) ?? (replaces ? entries.find(entry => entry.id === replaces) : undefined);
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
  // Nor inside a number: a quote ending in "1" would also be the start of "10".
  if (/[\d.,]$/.test(cut) && /^[\d.,]*\d/.test(flat.slice(QUOTE_LENGTH)) && /\d/.test(cut.at(-1)! + flat[QUOTE_LENGTH]!)) cut = cut.replace(/[+\-−±]?[\d.,]*$/, '');
  // Never stop inside a formula or a tag: an unclosed `$` or `<sup` would swallow the rest of the callout.
  if ((cut.match(/(?<!\\)\$/g)?.length ?? 0) % 2) cut = cut.slice(0, cut.lastIndexOf('$'));
  if (cut.lastIndexOf('<') > cut.lastIndexOf('>')) cut = cut.slice(0, cut.lastIndexOf('<'));
  return `${cut.trimEnd()}…`;
}

/** Whether `quote` (from the note) was taken from `text` (a paragraph of the current document). */
export function quoteMatches(quote: string, text: string): boolean {
  const flat = text.replace(/\s+/g, ' ').replace(/%%/g, '%').trim();
  if (quote && (flat === quote || (quote.length >= 20 && flat.startsWith(quote) && !continuesNumber(quote, flat)))) return true;
  // A normalizer may repair inline markup and OCR's o/0 confusion; the caller still requires a unique paragraph.
  const prefix = looseKey(quote), whole = looseKey(flat);
  const ocr = (value: string) => value.replace(/0/g, 'o');
  return prefix.length >= 20 && ocr(whole).startsWith(ocr(prefix)) && !continuesNumber(prefix, whole);
}

/** `whole` goes on with more of the number `prefix` ends in: "factor of 1" is not "factor of 10". */
function continuesNumber(prefix: string, whole: string): boolean {
  return /\d$/.test(prefix) && /^(?:\d|[.,]\d)/.test(whole.slice(prefix.length));
}

const SUPERSCRIPTS: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-' };

const TEX_SYMBOLS: Record<string, string> = { pm: '±', mp: '∓', lt: '<', gt: '>', le: '≤', leq: '≤', ge: '≥', geq: '≥', approx: '≈', sim: '≈' };
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', le: '≤', ge: '≥', asymp: '≈' };

/**
 * Letters and digits only, so spacing, markup and TeX commands do not count; but a number keeps
 * its sign, comparison, decimal point and exponent: -40 is not +40, <0.5 is not >0.5, .5 is not 5,
 * 1.0 is not 10 and 10^3 is not 103. Callers map OCR's 0/o themselves.
 */
function looseKey(value: string): string {
  return value
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+/g, run => `^${[...run].map(char => SUPERSCRIPTS[char]).join('')}`)
    .normalize('NFKC')
    .replace(/&(lt|gt|le|ge|asymp);/gi, (entity, name: string) => ENTITIES[name.toLowerCase()] ?? entity)
    .replace(/<sup\b[^<>]*>/gi, '^')
    .replace(/<\/?(?:span|sup|sub|em|strong|b|i|u|s|small|br|code|a)\b[^<>]*>/gi, '')
    .replace(/\\([A-Za-z]+)/g, (command, name: string) => TEX_SYMBOLS[name] ?? command)
    .replace(/\\(?:[A-Za-z]+|[^A-Za-z])/g, '')
    .replace(/[\u2010-\u2015\u2212\uFE63\uFF0D]/g, '-').replace(/[~∼]/g, '≈')
    // A leading decimal point, ".5", is the number 0.5; told apart before spacing goes.
    .replace(/(?<![\p{L}\p{N}.,])\.(?=\p{N})/gu, '0.')
    .replace(/[^\p{L}\p{N}+\-±∓^.,<>≤≥≈]/gu, '')
    .replace(/[.,](?!\p{N})|(?<!\p{N})[.,]/gu, '')
    .replace(/[+\-±∓](?!\p{N})/gu, '')
    .replace(/[<>≤≥≈](?![+\-±∓]?\p{N})/gu, '')
    .replace(/\^(?![+\-±∓]?\p{N})/gu, '')
    .toLowerCase();
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
  const starts: Array<{ line: number; id: string; broken?: true }> = [];
  let fence: Fence | undefined;
  for (let line = start; line < end; line++) {
    const inside = fence;
    fence = nextFence(fence, lines[line]!);
    // A marker shown inside a code fence is an example in someone's body, not an entry.
    if (inside || fence) continue;
    const valid = ENTRY_START.exec(lines[line]!);
    const damaged = valid ? undefined : DAMAGED_START.exec(lines[line]!);
    if (valid) starts.push({ line, id: valid[1]! });
    else if (damaged) starts.push({ line, id: (damaged[1] ?? damaged[2]!).replace(/%+\s*$/, '').trim(), broken: true });
  }
  const entries = starts.map(({ line, id, broken }, position): Entry => {
    const stop = starts[position + 1]?.line ?? end;
    let bodyStart = line + 1;
    while (bodyStart < stop && lines[bodyStart]!.startsWith('>')) bodyStart++;
    const quote = lines.slice(line + 1, bodyStart).map(text => text.replace(/^>\s?/, '')).join(' ').trim().replace(/…$/, '');
    return { id, quote, body: lines.slice(bodyStart, stop).join('\n').trim(), start: line, end: stop, ...(broken ? { broken } : {}) };
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
  let fence: Fence | undefined;
  lines.forEach((line, number) => {
    const inside = fence;
    fence = nextFence(fence, line);
    if (!inside && !fence) {
      const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*\r?$/.exec(line);
      if (heading) headings.push({ line: number, level: heading[1]!.length, text: heading[2]! });
    }
  });
  return headings;
}

interface Fence { marker: string; length: number }

/** The open code fence after `line`, given the one before it. */
function nextFence(fence: Fence | undefined, line: string): Fence | undefined {
  const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!marker) return fence;
  if (!fence) return { marker: marker[1]![0]!, length: marker[1]!.length };
  return marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim() ? undefined : fence;
}

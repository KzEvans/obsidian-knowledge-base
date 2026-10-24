import type { ReaderBlock, StoredDocument } from '../core/types';

/** Key ("4" for Figure 4, "scheme 1", "table 2") → asset references of its image blocks, in reading order. */
export type FigureIndex = Map<string, string[]>;

/** "Figure 3", "Fig. 3", "图 3", "Scheme 1", "方案 1", "Table 2", "表 2", and Wiley's letter-spaced "F I G U RE 3", "S CH E M E 1", "T AB L E 2". */
const LABEL = /^\s*(?:f\s*i\s*g(?:\s*u\s*r\s*e)?\s*\.?|图|(s\s*c\s*h\s*e\s*m\s*e|方案)|(t\s*a\s*b\s*l\s*e|表))\s*(s?)\s*(\d+)(?![\d.]*\d)/i;
/** What follows the number of a caption set above its image: "(a) …", "Conceptual …", ". …". */
const CAPTION_AFTER = /^\s*[.:|(（A-Z]/;
/** A caption that is only a panel letter: "(a)", "b)", "c". */
const PANEL = /^\s*\(?([a-z])\)?\s*$/i;
const LAYOUT_NOISE = new Set<ReaderBlock['kind']>(['header', 'footer', 'metadata']);
/** Normalized-bbox slack when deciding that a text block lies inside a figure. */
const INSIDE_TOLERANCE = 0.01;

type LabelKind = 'figure' | 'scheme' | 'table';
interface Label { kind: LabelKind; si: boolean; number: string; captionLike: boolean }

/** Index key: schemes and tables are numbered apart from figures. */
const keyOf = (kind: LabelKind, number: number) => kind === 'figure' ? String(number) : `${kind} ${number}`;
const kindOf = (scheme: string | undefined, table: string | undefined): LabelKind => scheme ? 'scheme' : table ? 'table' : 'figure';

/** One figure as MinerU split it: its image blocks, an optional caption paragraph, and text drawn inside it. */
export interface FigureGroup<B extends ReaderBlock = ReaderBlock> {
  /** Main-text key (see keyOf), labeled or inferred; undefined for SI and unnumbered figures. */
  number?: string;
  images: B[];
  /** A paragraph block that holds the caption, when the images carry none. */
  caption?: B;
  /** Text blocks that are part of the figure (labels, formulas), not body text. */
  inside: B[];
}

function labelIn(texts: readonly string[]): Label | undefined {
  for (const text of texts) {
    const plain = text.replace(/<[^>]*>/g, '');
    const match = LABEL.exec(plain);
    if (!match) continue;
    const kind = kindOf(match[1], match[2]);
    return { kind, si: Boolean(match[3]), number: keyOf(kind, Number(match[4])), captionLike: CAPTION_AFTER.test(plain.slice(match[0].length)) };
  }
  return undefined;
}

/** A figure or scheme label; table captions do not name image groups. */
function pictureLabel(texts: readonly string[]): Label | undefined {
  const label = labelIn(texts);
  return label?.kind === 'table' ? undefined : label;
}

export function isPanelCaption(caption: string): boolean {
  return PANEL.test(caption);
}

function panelLetter(block: ReaderBlock): string | undefined {
  for (const caption of block.captions ?? []) {
    const letter = PANEL.exec(caption)?.[1];
    if (letter) return letter.toLowerCase();
  }
  return undefined;
}

const nextLetter = (letter: string) => String.fromCharCode(letter.charCodeAt(0) + 1);
const pageOf = (block: ReaderBlock) => block.sources[0]?.page ?? 0;

/**
 * MinerU often splits one figure into several image blocks and puts the label in any of
 * their captions, in a paragraph right after the images, or loses it entirely, so:
 * - unlabeled image blocks before a label (a figure caption, or a caption-like paragraph
 *   directly after them, past any equation blocks) belong to that figure;
 * - unlabeled image blocks right after a figure on the same page, with no text between,
 *   belong to it; so does one whose panel letter continues the figure's, even past body
 *   text ("(b) FIGURE 5", then "(c)", "(d)");
 * - an unlabeled run on a later page than the previous figure takes the next unused number;
 * - a caption-like labeled paragraph directly above unlabeled images is their caption;
 * - text blocks lying inside a figure's images on the page are part of the figure.
 * SI figures ("Figure S3") are grouped but get no number.
 */
export function figureGroups<B extends ReaderBlock>(all: readonly B[]): FigureGroup<B>[] {
  const blocks = all.filter(block => !LAYOUT_NOISE.has(block.kind));
  const figureLabel = (block: B) => block.kind === 'figure' ? pictureLabel(block.captions?.length ? block.captions : [block.text]) : undefined;
  const claimed = new Set<string>();
  for (const block of blocks) {
    const label = figureLabel(block) ?? (block.kind === 'paragraph' ? pictureLabel([block.text]) : undefined);
    if (label && !label.si && (block.kind === 'figure' || label.captionLike)) claimed.add(label.number);
  }

  const groups: FigureGroup<B>[] = [];
  let pending: B[] = [];
  let between: B[] = [];
  /** A caption paragraph set above the images that follow it. */
  let above: { label: Label; block: B } | undefined;
  let last: { group: FigureGroup<B>; page: number; letter?: string | undefined } | undefined;
  /** Nothing but images since the last group ended. */
  let adjacent = false;
  const lastLetter = (images: readonly B[]) => images.map(panelLetter).filter(Boolean).at(-1);
  const close = (group: FigureGroup<B>, page: number) => {
    groups.push(group);
    last = { group, page, letter: lastLetter(group.images) };
    adjacent = true;
    pending = [];
    between = [];
    above = undefined;
  };
  const labeled = (label: Label, images: B[], page: number, caption?: B) => {
    close({ ...(label.si ? {} : { number: label.number }), images, ...(caption ? { caption } : {}), inside: between }, page);
  };
  const flush = () => {
    const first = pending[0];
    if (!first) { above = undefined; return; }
    const page = pageOf(pending.at(-1)!);
    if (above) { labeled(above.label, pending, page, above.block); return; }
    // Equations after an image run that no label closes are body text after all.
    between = [];
    if (last && adjacent && pageOf(first) === last.page) {
      last.group.images.push(...pending);
      last.letter = lastLetter(last.group.images);
      pending = [];
      return;
    }
    const previous = Number(last?.group.number);
    const next = Number.isInteger(previous) && last && pageOf(first) > last.page ? String(previous + 1) : undefined;
    if (next && !claimed.has(next)) { claimed.add(next); labeled({ kind: 'figure', si: false, number: next, captionLike: false }, pending, page); }
    else close({ images: pending, inside: between }, page);
  };

  blocks.forEach((block, index) => {
    const page = pageOf(block);
    if (block.kind !== 'figure') {
      // Formulas drawn inside a figure come out as equation blocks between its images and caption.
      if (block.kind === 'equation' && pending.length) { between.push(block); return; }
      // "Figure 5 shows …" is body text; only a caption-like paragraph is a caption.
      const label = block.kind === 'paragraph' ? pictureLabel([block.text]) : undefined;
      const caption = label?.captionLike ? label : undefined;
      if (caption && pending.length) { labeled(caption, pending, page, block); return; }
      flush();
      adjacent = false;
      const next = blocks[index + 1];
      if (caption && next?.kind === 'figure' && !figureLabel(next)) above = { label: caption, block };
      return;
    }
    const found = figureLabel(block);
    if (found) { labeled(found, [...pending, block], page); return; }
    const letter = panelLetter(block);
    // A continuing panel letter on the same page wins even past body text set between panels.
    if (!pending.length && last?.letter && letter === nextLetter(last.letter) && page === last.page) {
      last.group.images.push(block);
      last.letter = letter;
      adjacent = true;
      return;
    }
    pending.push(block);
  });
  flush();

  const taken = new Set<B>(groups.flatMap(group => [...group.images, ...group.inside, ...(group.caption ? [group.caption] : [])]));
  for (const group of groups) {
    for (const block of blocks) {
      if (block.kind !== 'figure' && block.kind !== 'table' && !taken.has(block) && insideImages(block, group.images)) {
        group.inside.push(block);
        taken.add(block);
      }
    }
  }
  return groups;
}

/** Every source of `block` lies within the union of the images' boxes on its page. */
function insideImages(block: ReaderBlock, images: readonly ReaderBlock[]): boolean {
  if (!block.sources.length) return false;
  return block.sources.every(source => {
    const boxes = images.flatMap(image => image.sources).filter(each => each.page === source.page && each.bbox).map(each => each.bbox!);
    if (!source.bbox || !boxes.length) return false;
    const [left, top, right, bottom] = source.bbox;
    return left >= Math.min(...boxes.map(box => box[0])) - INSIDE_TOLERANCE
      && top >= Math.min(...boxes.map(box => box[1])) - INSIDE_TOLERANCE
      && right <= Math.max(...boxes.map(box => box[2])) + INSIDE_TOLERANCE
      && bottom <= Math.max(...boxes.map(box => box[3])) + INSIDE_TOLERANCE;
  });
}

/** Main-text figure, scheme and table keys → image asset references, for hover previews. */
export function buildFigureIndex(document: Pick<StoredDocument, 'blocks'>): FigureIndex {
  const result: FigureIndex = new Map();
  for (const block of document.blocks) {
    const label = block.kind === 'table' ? labelIn(block.captions ?? []) : undefined;
    // Tables are rendered from an original-PDF crop, which is the asset.
    if (label?.kind === 'table' && !label.si && block.asset) result.set(label.number, [block.asset]);
  }
  for (const group of figureGroups(document.blocks)) {
    if (!group.number) continue;
    const assets = group.images.flatMap(image => image.asset ? [image.asset] : []);
    if (assets.length) result.set(group.number, [...(result.get(group.number) ?? []), ...assets]);
  }
  return result;
}

/** Cheap pre-check before findFigureRefs: could `text` mention a figure, scheme or table? */
export function mayReference(text: string): boolean {
  return /fig|scheme|table|图|方案|表/i.test(text);
}

/** One hover target: `number` is the index key (see keyOf); `start`–`end` are offsets into the scanned text. */
export interface FigureRef { number: string; start: number; end: number }

const REFERENCE = /(?<![A-Za-z])(?:Figures?|Figs?\.?|图|(Schemes?|方案)|(Tables?|(?<!代|发)表))\s*(S?\d+[A-Za-z]?(?:\s*(?:,|，|、|and|&|–|-|to|和|与|及)\s*S?\d*[A-Za-z]?(?![A-Za-z]))*)/gi;
const NUMBER = /(S?)(\d+)[A-Za-z]?/g;
const SUPPLEMENTARY = /(?:(?<![A-Za-z])(?:supplementary|extended\s+data|SI)|补充|附)\s*$/i;
/** What may precede a caption label on its line: markdown emphasis, quote, heading, list marks. */
const LINE_START = /^[\s*_>#\-+]*$/;

/**
 * Figure references in a run of body text. A caption label ("Figure 5." or "Fig. 4 |" at
 * the start of the text) is not a reference; with `caption` set the leading label is
 * skipped even without punctuation after it.
 */
export function findFigureRefs(text: string, caption = false): FigureRef[] {
  const refs: FigureRef[] = [];
  for (const match of text.matchAll(REFERENCE)) {
    const start = match.index;
    const before = text.slice(0, start);
    if (SUPPLEMENTARY.test(before)) continue;
    const kind = kindOf(match[1], match[2]);
    const list = match[3]!;
    const listStart = start + match[0].length - list.length;
    if (LINE_START.test(before)) {
      const after = text.slice(start + match[0].length);
      if (caption || /^\s*\**\s*[.:|：]/.test(after) || /^\s*\**\s*$/.test(after)) continue;
    }
    let first = true;
    for (const number of list.matchAll(NUMBER)) {
      const numberStart = listStart + number.index;
      const numberEnd = numberStart + number[0].length;
      if (!number[1]) refs.push({ number: keyOf(kind, Number(number[2])), start: first ? start : numberStart, end: numberEnd });
      first = false;
    }
  }
  return refs;
}

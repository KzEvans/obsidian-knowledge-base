/**
 * Deterministic lint for generated notes (docs/contracts.md §9). Pure: no I/O.
 * Protected regions (人工复核 / Human Review / 提问 sections, user-notes and
 * intensive-reading blocks) are written by the user and are not checked.
 */
import bannedList from './references/banned-phrases.md';

export interface LintProblem {
  rule: string;
  message: string;
  /** 1-based line in the note, when the problem has one location. */
  line?: number;
  section?: string;
}

export interface LintOptions {
  /** Count the 摘要翻译 section toward length; default false. */
  includeAbstractInLength?: boolean;
}

export interface LintResult {
  ok: boolean;
  problems: LintProblem[];
  /** Body length in characters, excluding frontmatter and 摘要翻译. */
  length: number;
}

export const SECTIONS = ['摘要翻译', '研究背景', '前人工作与不足', '作者的思考路径', '本文内容与创新点', '论点与证据', 'Takeaways', 'Follow-up ideas', '与现有知识的候选关联'] as const;
const ABSTRACT = SECTIONS[0];
const EVIDENCE = '论点与证据';
const PROTECTED_SECTIONS = new Set(['人工复核', 'Human Review', '提问']);

/** Body length bounds (characters as counted by {@link noteLength}). */
export const MIN_LENGTH = 1500;
export const MAX_LENGTH = 3000;
/** Bold spans allowed in one section. */
export const MAX_BOLD_PER_SECTION = 2;
/** Hedge words (list in references/banned-phrases.md) allowed in the whole body. */
export const MAX_HEDGES = 12;
/** Numbers per 100 characters in 论点与证据, not counting figure, table and equation labels. */
export const MAX_EVIDENCE_NUMBERS_PER_100 = 2;
/** Below this section length the density rule uses this length, so one number in a short section passes. */
const MIN_DENSITY_BASE = 200;

function listUnder(heading: string): string[] {
  const block = bannedList.split(/^## /m).find(part => part.startsWith(heading));
  return block ? [...block.matchAll(/^- (.+)$/gm)].map(match => match[1]!.trim()) : [];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `……` in a listed phrase stands for any text inside one sentence. */
const phrasePattern = (phrase: string) => new RegExp(phrase.split('……').map(escape).join('[^。！？\\n]{0,40}?'), 'g');

export const BANNED_PHRASES: readonly string[] = listUnder('禁用词');
export const HEDGE_WORDS: readonly string[] = listUnder('对冲词');
const BANNED = BANNED_PHRASES.map(phrase => ({ phrase, pattern: phrasePattern(phrase) }));
const HEDGE = new RegExp(`(?<!不)(?:${HEDGE_WORDS.map(escape).join('|')})`, 'g');

interface Line { number: number; text: string }
interface Section { title: string; heading: number; lines: Line[] }

/** Blank out frontmatter and user-owned regions so line numbers stay true. */
function checkedLines(markdown: string): Line[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n').map((text, index) => ({ number: index + 1, text }));
  const blank = (line: Line) => { line.text = ''; };
  if (lines[0]?.text.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.text.trim() === '---');
    if (end > 0) lines.slice(0, end + 1).forEach(blank);
  }
  // Code examples must not create protection state or consume real prose after the closing fence.
  let fence: { marker: string; length: number } | undefined;
  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (fence) {
      if (match && match[1]![0] === fence.marker && match[1]!.length >= fence.length && !match[2]!.trim()) fence = undefined;
      blank(line);
    } else if (match) {
      fence = { marker: match[1]![0]!, length: match[1]!.length };
      blank(line);
    }
  }
  let protectedLevel = 0;
  let marker: string | undefined;
  for (const line of lines) {
    const start = /<!--\s*(user-notes|intensive-reading:[^:\s]+):start\s*-->/.exec(line.text);
    if (!marker && start) marker = start[1];
    if (marker) {
      const done = new RegExp(`<!--\\s*${escape(marker)}:end\\s*-->`).test(line.text);
      blank(line);
      if (done) marker = undefined;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.text);
    if (heading) {
      const level = heading[1]!.length;
      if (protectedLevel && level <= protectedLevel) protectedLevel = 0;
      if (!protectedLevel && PROTECTED_SECTIONS.has(heading[2]!)) protectedLevel = level;
    }
    if (protectedLevel) blank(line);
  }
  return lines;
}

function splitSections(lines: Line[]): { preamble: Line[]; sections: Section[] } {
  const preamble: Line[] = [];
  const sections: Section[] = [];
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line.text);
    if (heading) sections.push({ title: heading[1]!, heading: line.number, lines: [] });
    else (sections[sections.length - 1]?.lines ?? preamble).push(line);
  }
  return { preamble, sections };
}

/** Prose without Markdown syntax, comments, link targets or math delimiters. */
function prose(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`$>]/g, '');
}

/**
 * Length as Chinese word processors count it: each CJK character or full-width
 * punctuation mark is one, each run of Latin letters or digits is one.
 */
export function noteLength(text: string): number {
  const cjk = text.match(/[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/g)?.length ?? 0;
  const words = text.match(/[A-Za-z0-9]+(?:[.'’-][A-Za-z0-9]+)*/g)?.length ?? 0;
  return cjk + words;
}

const LABELLED_NUMBER = /(?:图|表|式|公式|Fig(?:ure)?s?\.?|Tables?|Eqs?\.?|Ref(?:erence)?s?\.?|参考文献)\s*S?\d+[a-zA-Z]?(?:\s*[,，、–—-]\s*S?\d+[a-zA-Z]?)*/g;
const NUMBER = /\d+(?:[.,]\d+)?/g;
const CITATION = /\[\d+(?:\s*[,，;；–—-]\s*\d+)*\]/g;
const referenceLabel = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();

export function lintNote(markdown: string, options: LintOptions = {}): LintResult {
  const problems: LintProblem[] = [];
  const lines = checkedLines(markdown);
  const { preamble, sections } = splitSections(lines);
  const references = new Set(lines.flatMap(line => {
    const label = /^ {0,3}\[([^\]]+)\]:\s*\S/.exec(line.text)?.[1];
    return label ? [referenceLabel(label)] : [];
  }));

  // Structure: the 9 sections, once each, in order; only protected sections may follow.
  const titles = sections.map(section => section.title);
  for (const title of SECTIONS) {
    const count = titles.filter(found => found === title).length;
    if (count === 0) problems.push({ rule: 'sections', message: `缺少「${title}」一节。`, section: title });
    if (count > 1) problems.push({ rule: 'sections', message: `「${title}」一节出现了 ${count} 次。`, section: title });
  }
  for (const section of sections) {
    if (!(SECTIONS as readonly string[]).includes(section.title)) {
      problems.push({ rule: 'sections', message: `多出的二级标题「${section.title}」，模板只有 9 节。`, line: section.heading, section: section.title });
    }
  }
  const known = titles.filter(title => (SECTIONS as readonly string[]).includes(title));
  const expected = SECTIONS.filter(title => known.includes(title));
  if ([...new Set(known)].join('\n') !== expected.join('\n')) {
    problems.push({ rule: 'section-order', message: `节的顺序不对，应为：${SECTIONS.join('、')}。` });
  }

  // Heading levels never skip (a `##` followed directly by `####`).
  let previous = 1;
  for (const line of lines) {
    const heading = /^(#{1,6})\s/.exec(line.text);
    if (!heading) continue;
    const level = heading[1]!.length;
    if (level > previous + 1) problems.push({ rule: 'heading-skip', message: `标题从 ${'#'.repeat(previous)} 跳到 ${'#'.repeat(level)}。`, line: line.number });
    previous = level;
  }

  const located = [{ title: undefined as string | undefined, lines: preamble }, ...sections];
  let hedges = 0;
  let length = 0;
  for (const section of located) {
    const sectionName = section.title;
    const where = (line?: Line) => ({ ...(line ? { line: line.number } : {}), ...(sectionName ? { section: sectionName } : {}) });
    let bold = 0;
    let sectionLength = 0;
    let numbers = 0;
    for (const line of section.lines) {
      if (sectionName === undefined && /^#\s+/.test(line.text)) continue;
      if (/#page=/.test(line.text)) problems.push({ rule: 'page-link', message: '不要写页码链接（#page=）。', ...where(line) });
      const images = [...line.text.matchAll(/!\[([^\]]*)\](?:\[([^\]]*)\])?/g)];
      if (/!\[\[|!\[[^\]]*\]\(/.test(line.text) || images.some(match => references.has(referenceLabel(match[2] || match[1]!)))) problems.push({ rule: 'embed', message: '不要嵌入图片，写“图 N 显示……”。', ...where(line) });
      if (sectionName === ABSTRACT) {
        if (options.includeAbstractInLength) length += noteLength(prose(line.text));
        continue;
      }
      const text = prose(line.text);
      for (const { phrase, pattern } of BANNED) {
        const count = text.match(pattern)?.length ?? 0;
        if (count) problems.push({ rule: 'banned-phrase', message: `禁用词「${phrase}」${count > 1 ? `出现 ${count} 次` : ''}。`, ...where(line) });
      }
      hedges += text.match(HEDGE)?.length ?? 0;
      const spans = line.text.match(/\*\*[^*\n]+?\*\*|__[^_\n]+?__/g) ?? [];
      bold += spans.length;
      if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*[^*\n]+?[:：]\*\*|\*\*[^*\n]+?\*\*\s*[:：]|__[^_\n]+?[:：]__|__[^_\n]+?__\s*[:：])/.test(line.text)) {
        problems.push({ rule: 'bold-label', message: '不要用加粗当行首小标题，改用标题或列表层级。', ...where(line) });
      }
      sectionLength += noteLength(text);
      if (sectionName === EVIDENCE) numbers += text.replace(LABELLED_NUMBER, '').replace(CITATION, '').match(NUMBER)?.length ?? 0;
    }
    if (bold > MAX_BOLD_PER_SECTION) {
      problems.push({ rule: 'bold', message: `本节加粗 ${bold} 处，上限 ${MAX_BOLD_PER_SECTION}。`, ...where() });
    }
    if (sectionName === EVIDENCE) {
      const density = numbers / Math.max(sectionLength, MIN_DENSITY_BASE) * 100;
      if (density > MAX_EVIDENCE_NUMBERS_PER_100) {
        problems.push({ rule: 'evidence-numbers', message: `「论点与证据」每 100 字有 ${density.toFixed(1)} 个数字，上限 ${MAX_EVIDENCE_NUMBERS_PER_100}；只保留决定性的数字。`, section: EVIDENCE });
      }
    }
    length += sectionLength;
  }

  if (hedges > MAX_HEDGES) problems.push({ rule: 'hedges', message: `对冲词（${HEDGE_WORDS.join('、')}）共 ${hedges} 处，上限 ${MAX_HEDGES}。` });
  if (length < MIN_LENGTH || length > MAX_LENGTH) {
    problems.push({ rule: 'length', message: `正文 ${length} 字，建议 ${MIN_LENGTH}–${MAX_LENGTH} 字。` });
  }

  return { ok: problems.length === 0, problems, length };
}

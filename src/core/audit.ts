import { extractNativeRegion } from './native-text';
import { parseCaptionLabel } from './normalize';
import type { PdfPage, PdfTextItem } from './obsidian-internal';
import type { ReaderBlock, ReaderDocument, SourceRef } from './types';

/** The subset of a pdf.js document the audit reads; tests supply small fakes. */
export interface AuditPdf {
  numPages: number;
  getPage(page: number): Promise<Pick<PdfPage, 'getTextContent' | 'getViewport'>>;
}

const isTextItem = (item: unknown): item is PdfTextItem =>
  typeof item === 'object' && item !== null && typeof (item as { str?: unknown }).str === 'string';

export async function auditNativeText(
  pdf: AuditPdf,
  document: ReaderDocument,
  mergedBlockIds?: ReadonlySet<ReaderBlock['id']>,
): Promise<void> {
  const originallyEmpty = new Set(document.blocks.filter(block => block.kind === 'paragraph' && !block.text.trim()).map(block => block.id));
  const pendingContinuations = new Set(document.blocks.filter(block =>
    originallyEmpty.has(block.id) && !block.html && mergedBlockIds?.has(block.id),
  ));
  const pageWordEvidence = new Map<number, {words:Set<string>;compact:string[]}>();
  for (let page = 1; page <= pdf.numPages; page++) {
    const pdfPage = await pdf.getPage(page);
    const content = await pdfPage.getTextContent();
    const viewport = pdfPage.getViewport({ scale: 1 });
    const textItems = (content.items ?? []).filter(isTextItem);
    const native = textItems.map(item => item.str).join(' ').normalize('NFKC');
    const canAuditPage = native.replace(/\s/g, '').length >= 80;
    const pageBlocks = document.blocks.filter(block => block.sources.some(source => source.page === page));
    if (!canAuditPage && !pageBlocks.some(block => pendingContinuations.has(block))) continue;

    const regions = new Map<ReaderBlock, string[]>();
    const textBySource = new Map<SourceRef, string>();
    const regionalTexts: string[] = [];
    for (const block of pageBlocks) {
      const texts: string[] = [];
      for (const source of block.sources) {
        if (source.page !== page || !source.bbox) continue;
        const text = extractNativeRegion(textItems, viewport, source.bbox);
        textBySource.set(source, text);
        texts.push(text);
      }
      regions.set(block, texts);
      regionalTexts.push(...texts.filter(Boolean));
    }
    const sourceTexts = [native, ...regionalTexts];
    // A missing ligature letter can otherwise break the anchors used for prose recovery.
    const nativeLetters = native.toLowerCase().replace(/[^a-z]/g, '');
    for (const block of canAuditPage ? pageBlocks : []) {
      repairBlockLigatures(block, sourceTexts, regions.get(block) ?? []);
      restoreLostLigatureF(block, nativeLetters);
      if (block.kind === 'paragraph') {
        block.text = restoreVerifiedInlineProse(block.text, regions.get(block) ?? []);
        block.text = restoreMissingProse(block.text, regions.get(block) ?? [], pageBlocks.filter(other => other !== block));
        block.text = restoreVerifiedTypography(block.text, regions.get(block) ?? []);
      }
    }

    for (const block of pageBlocks) {
      if (!document.blocks.includes(block)) continue;
      const regional = regions.get(block)?.[0];
      if (pendingContinuations.has(block)) {
        const duplicate = regional && findDuplicateOwner(document.blocks, block, regional, sourceTexts, textBySource, page, true);
        if (duplicate) {
          mergeSources(duplicate.owner, block.sources);
          removeContinuation(document, block);
          pendingContinuations.delete(block);
        }
        continue;
      }
      if (canAuditPage && regional && ['paragraph', 'heading'].includes(block.kind)) {
        if (originallyEmpty.has(block.id)) {
          const duplicate = findDuplicateOwner(document.blocks, block, regional, sourceTexts, textBySource, page);
          if (duplicate) {
            if (duplicate.correctedText !== undefined) duplicate.owner.text = duplicate.correctedText;
            mergeSources(duplicate.owner, block.sources);
            document.blocks.splice(document.blocks.indexOf(block), 1);
          } else {
            block.text = regional;
          }
          clearEmptyWarning(document, block);
        } else if (block.kind === 'heading' && !block.text.includes('$') && plainLetters(regional) === plainLetters(block.text) && regional !== block.text) {
          block.text = regional;
        }
      }
    }
    if (!canAuditPage) continue;
    for (const block of pageBlocks) {
      if (document.blocks.includes(block)) restoreBlockSubscripts(block,regions.get(block) ?? []);
    }
    const blocks = document.blocks.filter(block => block.sources.some(source => source.page === page));
    if (!blocks.length) document.warnings.push(`第 ${page} 页没有可用重排内容，请查看原页。`);
    const sourceText = sourceTexts.join(' ').replace(/<[^>]*>/g, ' ').normalize('NFKC');
    pageWordEvidence.set(page,{
      words:new Set((sourceText.match(/[A-Za-z]{4,}/g) ?? []).map((word: string) => word.toLowerCase())),
      compact:sourceTexts.map(compactText),
    });
  }
  for (const block of pendingContinuations) {
    removeContinuation(document, block);
    document.warnings.push(`内容块 ${block.id.replace('block-', '')}（第 ${block.sources[0]?.page ?? '?'} 页）续段来源待核对。`);
  }
  // Later pages can prove that an earlier cloud paragraph spans both pages.
  // Score only after that provenance has been merged, avoiding false alarms.
  for (const [page,evidence] of pageWordEvidence) {
    const blocks = document.blocks.filter(block => block.sources.some(source => source.page === page));
    const extracted = blocks.filter(block =>
      ['paragraph', 'heading', 'footnote', 'list'].includes(block.kind) &&
      new Set(block.sources.map(source => source.page)).size === 1,
    ).map(block => block.text).join(' ').replace(/<[^>]*>/g, ' ').normalize('NFKC');
    const words = extracted.match(/[A-Za-z]{4,}/g) ?? [];
    const verified = words.filter(word => {
      const lower=word.toLowerCase();
      return evidence.words.has(lower) || evidence.compact.some(source=>source.includes(lower));
    });
    if (words.length > 30 && verified.length / words.length < 0.7) document.warnings.push(`第 ${page} 页文本与原文差异较多，请核对原页。`);
  }
  document.warnings = [...new Set(document.warnings)];
}

function removeContinuation(document: ReaderDocument, block: ReaderBlock): void {
  document.blocks.splice(document.blocks.indexOf(block), 1);
  clearEmptyWarning(document, block);
}

function clearEmptyWarning(document: ReaderDocument, block: ReaderBlock): void {
  document.warnings = document.warnings.filter(warning => warning !== `内容块 ${block.id.replace('block-', '')} 没有可显示内容。`);
}

function repairBlockLigatures(block: ReaderBlock, nativeTexts: string[], regionalTexts: string[]): void {
  for (const field of ['text', 'html'] as const) {
    const value = block[field];
    if (value) block[field] = repairVerifiedLigatures(value, nativeTexts, regionalTexts);
  }
  for (const field of ['captions', 'footnotes'] as const) {
    if (block[field]) block[field] = block[field].map(value => repairVerifiedLigatures(value, nativeTexts, regionalTexts));
  }
}

function restoreBlockSubscripts(block: ReaderBlock, regions: string[]): void {
  if (['metadata','header','footer','references'].includes(block.kind)) return;
  for (const field of ['text','html'] as const) {
    if (block[field]) block[field]=restoreVerifiedSubscripts(block[field],regions);
  }
  for (const field of ['captions','footnotes'] as const) {
    if (block[field]) block[field]=block[field].map(value=>restoreVerifiedSubscripts(value,regions));
  }
}

/** OCR can read an ff/ffi ligature glyph as one f ("ofers", "eficient"). A word is
 * repaired only when the native page letters, read with its neighbouring words,
 * lack the cloud spelling and contain exactly one doubled-f spelling. Markup,
 * TeX and short words stay as-is. */
function restoreLostLigatureF(block: ReaderBlock, nativeLetters: string): void {
  if (['metadata','header','footer'].includes(block.kind)) return;
  const repair = (value: string) => {
    const tokens = [...value.matchAll(/<[^>]*>|\$\$?[\s\S]*?\$\$?|\\[A-Za-z]+|[A-Za-z]+/g)];
    const words = tokens.filter(token => /^[A-Za-z]+$/.test(token[0]));
    const replacements = new Map<number, string>();
    words.forEach((word, position) => {
      const token = word[0];
      if (token.length < 4 || !/f/i.test(token)) return;
      const lower = token.toLowerCase();
      const previous = words[position - 1]?.[0].toLowerCase() ?? '';
      const next = words[position + 1]?.[0].toLowerCase() ?? '';
      // Widest context first; a short word alone is too common to prove anything.
      for (const [left, right] of [[previous, next], [previous, ''], ['', next]]) {
        if (!left && !right) continue;
        if (nativeLetters.includes(left + lower + right)) return;
        const candidates = new Set<string>();
        for (let index = 0; index < token.length; index++) {
          if (lower[index] !== 'f') continue;
          const doubled = lower.slice(0, index + 1) + 'f' + lower.slice(index + 1);
          if (nativeLetters.includes(left + doubled + right)) candidates.add(token.slice(0, index + 1) + 'f' + token.slice(index + 1));
        }
        if (candidates.size > 1) return;
        if (candidates.size === 1) { replacements.set(word.index, [...candidates][0]!); return; }
      }
    });
    let result = value;
    for (const [start, replacement] of [...replacements].sort((a, b) => b[0] - a[0])) {
      result = result.slice(0, start) + replacement + result.slice(start + replacement.length - 1);
    }
    return result;
  };
  for (const field of ['text','html'] as const) {
    if (block[field]) block[field] = repair(block[field]);
  }
  for (const field of ['captions','footnotes'] as const) {
    if (block[field]) block[field] = block[field].map(repair);
  }
}

/** Existing subscript contents are not part of the baseline-letter anchors. */
function mapBaselineLetters(value: string): LetterMap {
  return mapLetters(value.replace(/<sub\b[^>]*>[\s\S]*?<\/sub>|_\s*\{[^{}]*\}|_[A-Za-z0-9+-]|[\u2080-\u209F]/gi,
    token=>' '.repeat(token.length)));
}

function restoreVerifiedSubscripts(cloud: string, regions: string[]): string {
  const mapped=mapBaselineLetters(cloud);
  const operations=new Map<number,{end:number;text:string}>();
  const conflicts=new Set<number>();
  for (const regional of regions) {
    const native=mapBaselineLetters(regional);
    for (const subscript of regional.matchAll(/<sub>([^<]+)<\/sub>/g)) {
      const code=subscript[1]!.normalize('NFKC').replace(/\s/g,'');
      if (!/^[A-Za-z0-9+-]{1,8}$/.test(code)) continue;
      const nativeIndex=native.spans.findIndex(span=>span.start>=subscript.index);
      const split=nativeIndex<0 ? native.spans.length : nativeIndex;
      if (!split) continue;
      let target:number|undefined;
      for (const width of [24,16,8,4]) {
        const left=native.letters.slice(Math.max(0,split-width),split);
        const right=native.letters.slice(split,split+24);
        const anchor=left+right;
        if (anchor.length<16) continue;
        const match=mapped.letters.indexOf(anchor);
        if (match>=0 && mapped.letters.indexOf(anchor,match+1)<0) { target=match+left.length;break; }
      }
      if (target===undefined) continue;
      const before=mapped.spans[target-1];
      if (!before) continue;
      const next=mapped.spans[target];
      const nativeBefore=native.spans[split-1]!;
      const closing=regional.slice(nativeBefore.end,subscript.index).replace(/\s/g,'');
      if (!/^[)\]}]*$/.test(closing)) continue;
      const gap=cloud.slice(before.end,next?.start ?? cloud.length);
      const prefix=closing ? gap.match(new RegExp('^\\s*'+closing.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))) : [''];
      if (!prefix) continue;
      const position=before.end+prefix[0]!.length;
      const remaining=cloud.slice(position,next?.start ?? cloud.length);
      // Preserve existing indices, including cloud TeX with spaced digits.
      // This pass repairs omissions; differing existing values need a review.
      if (/<sub\b|_\s*(?:\{|[A-Za-z0-9+-])/.test(remaining)) continue;
      const existing=remaining.match(/^\s*(?:<sup>([^<]+)<\/sup>|([\u2080-\u209F]+)|([0-9]+))/);
      let end=position;
      if (existing) {
        if ((existing[1] ?? existing[2] ?? existing[3] ?? '').normalize('NFKC').replace(/\s/g,'')!==code) continue;
        end=position+existing[0].length;
      }
      const math=[...cloud.matchAll(/(?<!\\)\$\$?[\s\S]*?(?<!\\)\$\$?/g)]
        .find(formula=>position>formula.index && position<formula.index+formula[0].length);
      const text=math ? `_{${code}}` : `<sub>${code}</sub>`;
      const previous=operations.get(position);
      if (previous && (previous.end!==end || previous.text!==text)) conflicts.add(position);
      else operations.set(position,{end,text});
    }
  }
  let result=cloud;
  for (const [start,operation] of [...operations].sort((a,b)=>b[0]-a[0])) {
    if (!conflicts.has(start)) result=result.slice(0,start)+operation.text+result.slice(operation.end);
  }
  return result;
}

function repairVerifiedLigatures(value: string, sourceTexts: string[], regionalTexts: string[]): string {
  const evidence = sourceTexts.map(compactText);
  return value.replace(/([A-Za-z]*)<sup\b[^>]*>(fi|fl|ff|ffi|ffl|f)<\/sup>([A-Za-z]*)/g,
    (original: string, before: string, ligature: string, after: string, offset: number) => {
      if (!before && !after) return original;
      if (!/[a-z]/.test(before + after)) return original;
      if (regionalTexts.some(text => text.includes(original))) return original;
      const variants = [...new Set([ligature, ...(ligature === 'f' ? ['ff'] : ligature === 'fi' ? ['ffi'] : ligature === 'fl' ? ['ffl'] : [])])];
      const prefix = stripMarkup(value.slice(0, offset)).match(/([A-Za-z]+)[^A-Za-z]*$/)?.[1] ?? '';
      const suffix = stripMarkup(value.slice(offset + original.length)).match(/^[^A-Za-z]*([A-Za-z]+)/)?.[1] ?? '';
      for (const variant of variants) {
        const candidate = before + variant + after;
        if ((prefix || suffix) && evidence.some(text => text.includes(compactText(prefix + candidate + suffix)))) return candidate;
      }
      for (const variant of variants) {
        const candidate = before + variant + after;
        if (candidate.length >= 4 && evidence.some(text => text.includes(compactText(candidate)))) return candidate;
      }
      return original;
    });
}

interface DuplicateOwner {
  owner: ReaderBlock;
  correctedText?: string;
}

function findDuplicateOwner(
  blocks: ReaderBlock[], empty: ReaderBlock, regional: string, sourceTexts: string[],
  textBySource: ReadonlyMap<SourceRef, string>, page: number, marked = false,
): DuplicateOwner | undefined {
  const fragment = compactText(regional);
  const box = empty.sources.find(source => source.page === page && source.bbox)?.bbox;
  if (!box || !fragment || (!marked && fragment.length < 80)) return undefined;
  const index = blocks.indexOf(empty);
  const candidates: ReaderBlock[] = [];
  // Count prose blocks, so headers, publisher controls, and floating figures do
  // not turn an adjacent-page continuation into a distant paragraph.
  for (const direction of [-1, 1]) {
    let prose = 0;
    for (let cursor = index + direction; cursor >= 0 && cursor < blocks.length && prose < 4; cursor += direction) {
      const candidate = blocks[cursor]!;
      if (candidate.kind !== 'paragraph' || !candidate.text.trim()) continue;
      if (marked && (candidate.hiddenByDefault || candidate.html || parseCaptionLabel(candidate.text)?.captionLike)) continue;
      prose++;
      if (connectedSources(empty.sources, candidate.sources)) candidates.push(candidate);
    }
  }
  // A repeated source passage can be genuine prose in both layout regions.
  const pageText = compactText(sourceTexts[0] ?? '');
  const nativeIndex = pageText.indexOf(fragment);
  if (nativeIndex >= 0 && pageText.indexOf(fragment, nativeIndex + 1) >= 0) return undefined;
  const nativeLetters = marked ? mapLigatureLetters(regional).letters : '';
  const markedMatches = (text: string) => countContinuationMatches(text, regional, fragment, nativeLetters);
  // PDF item order need not match the geometric region's reading order.
  // Another disjoint original region containing the passage proves a repeat.
  if (candidates.some(owner => owner.sources.some(source => {
    const b = source.bbox;
    if (source.page !== page || !b) return false;
    const disjoint = box[2] <= b[0] || b[2] <= box[0] || box[3] <= b[1] || b[3] <= box[1];
    const text = textBySource.get(source) ?? '';
    return disjoint && (marked ? markedMatches(text) > 0 : compactText(text).includes(fragment));
  }))) return undefined;
  if (marked) {
    let owner: ReaderBlock | undefined;
    for (const candidate of candidates) {
      const count = markedMatches(candidate.text);
      if (!count) continue;
      if (owner || count > 1) return undefined;
      owner = candidate;
    }
    return owner && blocks.indexOf(owner) < index ? { owner } : undefined;
  }
  for (const candidate of candidates) repairBlockLigatures(candidate, sourceTexts, []);
  const matches = candidates.flatMap(owner => findNativeSpans(owner.text, regional).map(span => ({owner,span})));
  if (!matches.length) {
    // Cloud OCR may drop an isolated letter ("monome conversion") inside the copied passage.
    const native = mapLetters(regional).letters;
    const owners = candidates.filter(owner => countDroppedLetterMatches(mapLetters(owner.text).letters, native) === 1);
    return owners.length === 1 ? {owner:owners[0]!} : undefined;
  }
  if (matches.length !== 1) return undefined;
  const {owner,span} = matches[0]!;
  if (compactText(owner.text).includes(fragment)) return {owner};
  const correctedText = replaceUniqueNativeSpan(owner.text, regional, span);
  return correctedText === undefined ? undefined : {owner,correctedText};
}

interface LetterMap {
  letters: string;
  spans: {start:number;end:number}[];
}

/** Recover ordinary temperature ranges and reference numbers from their unique native context. */
function restoreVerifiedInlineProse(cloud: string, regions: string[]): string {
  const formulas = [...cloud.matchAll(/(?<!\\)\$\$?[\s\S]*?(?<!\\)\$\$?/g)];
  const native = regions.filter(Boolean).map(text => ({ text, ...mapLetters(text, true) }));
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const [index, formula] of formulas.entries()) {
    const previous = formulas[index - 1], next = formulas[index + 1];
    const before = cloud.slice(previous ? previous.index + previous[0].length : 0, formula.index);
    const after = cloud.slice(formula.index + formula[0].length, next?.index);
    const leftMap = mapLetters(before, true), rightMap = mapLetters(after, true);
    const left = leftMap.letters.slice(-32), right = rightMap.letters.slice(0, 32);
    if (left.length < 8 || right.length < 8 || left.length + right.length < 24) continue;
    const prefix = stripMarkup(before.slice(leftMap.spans.at(-1)!.end)).trim();
    const suffix = stripMarkup(after.slice(0, rightMap.spans[0]!.start)).trim();
    const reference = /(?:Figure|Fig\.?|Table|Eq\.?|Equation|Scheme)\s*$/i.test(before);
    const candidates = new Set<string>();
    for (const source of native) {
      const at = source.letters.indexOf(left);
      if (at < 0 || source.letters.indexOf(left, at + 1) >= 0) continue;
      const end = source.letters.indexOf(right, at + left.length);
      if (end < 0 || source.letters.indexOf(right) !== end || source.letters.indexOf(right, end + 1) >= 0) continue;
      let text = source.text.slice(source.spans[at + left.length - 1]!.end, source.spans[end]!.start).trim();
      if (prefix) {
        if (!text.startsWith(prefix)) continue;
        text = text.slice(prefix.length).trim();
      }
      if (suffix) {
        if (!text.endsWith(suffix)) continue;
        text = text.slice(0, -suffix.length).trim();
      }
      const plain = stripMarkup(text);
      const temperature = /^[+−-]?\d+(?:\.\d+)?(?:\s+to\s+[+−-]?\d+(?:\.\d+)?)?\s*°\s*[CFK]$/.test(plain);
      const number = reference && /^\d+(?:\.\d+)?[a-z]?[.)]?$/i.test(text);
      if (temperature || number) candidates.add(text);
    }
    if (candidates.size === 1) edits.push({ start: formula.index, end: formula.index + formula[0].length, text: [...candidates][0]! });
  }
  let result = cloud;
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

/** Recover omitted prose only between unique, adjacent cloud anchors in the same PDF region.
 * Existing words and TeX are never replaced; native punctuation and citations travel with the gap.
 * A region box can reach into a neighbouring block; text another block on the page already has is its own. */
function restoreMissingProse(cloud: string, regions: string[], neighbours: ReaderBlock[]): string {
  let owned: string[] | undefined;
  /** Where prose another block already holds begins in `text`: 0 when all of it is theirs, text.length when none is.
   * Spilled text starts at a neighbour's opening letters; a short common phrase elsewhere proves nothing. */
  const ownedFrom = (text: string): number => {
    const { letters, spans } = mapLetters(text);
    owned ??= neighbours.map(block => mapLetters(block.text).letters).filter(other => other.length >= 8);
    let at = letters.length;
    for (const other of owned) {
      if (letters.length >= 24 && other.includes(letters)) return 0;
      const head = other.slice(0, 24);
      const found = letters.indexOf(head);
      if (found >= 0) at = Math.min(at, found);
      // The region may end partway into the neighbour's first line.
      for (let length = Math.min(head.length - 1, letters.length); length >= 8; length--) {
        if (letters.endsWith(head.slice(0, length))) { at = Math.min(at, letters.length - length); break; }
      }
    }
    return at >= letters.length ? text.length : at === 0 ? 0 : spans[at]!.start;
  };
  const mapped = mapLetters(cloud);
  const native = regions.filter(Boolean).map(text => ({ text, ...mapLetters(text) }));
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const formulas = [...cloud.matchAll(/(?<!\\)\$\$?[\s\S]*?(?<!\\)\$\$?/g)];
  const width = 24;
  for (let split = width; split <= mapped.letters.length - width; split++) {
    const start = mapped.spans[split - 1]!.end;
    const end = mapped.spans[split]!.start;
    const gap = cloud.slice(start, end);
    const visibleGap = gap.replace(/<\/?sup\b[^>]*>/gi, '');
    // A scientific comparison such as "<0.02" is not an opening HTML tag.
    // Remove only citation tags here so malformed markup cannot hide existing prose.
    if (!/\s/.test(gap) || /[$\\A-Za-z]/.test(visibleGap)) continue;
    if (formulas.some(formula => start < formula.index + formula[0].length && end > formula.index)) continue;
    const left = mapped.letters.slice(split - width, split);
    const right = mapped.letters.slice(split, split + width);
    const candidates = new Set<string>();
    for (const source of native) {
      const leftAt = source.letters.indexOf(left);
      if (leftAt < 0 || source.letters.indexOf(left, leftAt + 1) >= 0) continue;
      const afterLeft = leftAt + width;
      const rightAt = source.letters.indexOf(right, afterLeft);
      if (rightAt < 0 || source.letters.indexOf(right) !== rightAt || source.letters.indexOf(right, rightAt + 1) >= 0) continue;
      const missing = rightAt - afterLeft;
      if (missing < 2 || missing > 500) continue;
      const text = source.text.slice(source.spans[afterLeft - 1]!.end, source.spans[rightAt]!.start);
      const plain = stripMarkup(text);
      const symbol = visibleGap.match(/^\s*([\p{Script=Greek}])\s*[:;,.]?\s*$/u)?.[1];
      const shortLabel = symbol && new RegExp(`^\\s*${symbol}[A-Za-z]{1,8}\\s*[:;,.]?\\s*$`, 'u').test(plain);
      if ((missing < 8 || (plain.match(/[A-Za-z]{2,}/g)?.length ?? 0) < 2) && !shortLabel) continue;
      // Existing citation or measurement digits must survive in order, even when the cloud lost other numbers.
      if (preservesNumbers(visibleGap, text) && ownedFrom(text) === text.length) candidates.add(text);
    }
    if (candidates.size === 1) edits.push({ start, end, text: [...candidates][0]! });
  }
  // OCR can leave just a broken ligature and citation where a paragraph's last clause belonged.
  const tailWidth = 48;
  for (let split = Math.max(tailWidth, mapped.letters.length - 3); split <= mapped.letters.length; split++) {
    const start = mapped.spans[split - 1]!.end;
    const tail = cloud.slice(start);
    const residual = tail.replace(/<(?:sup|sub)\b[^>]*>(?:fi|fl|ff|ffi|ffl|f)<\/(?:sup|sub)>/gi, '');
    if (/[$\\A-Za-z]/.test(residual.replace(/<\/?(?:sup|sub)\b[^>]*>/gi, ''))) continue;
    if (formulas.some(formula => start < formula.index + formula[0].length)) continue;
    const anchor = mapped.letters.slice(split - tailWidth, split);
    if (mapped.letters.indexOf(anchor) !== split - tailWidth || mapped.letters.indexOf(anchor, split - tailWidth + 1) >= 0) continue;
    const candidates = new Set<string>();
    for (const source of native) {
      const at = source.letters.indexOf(anchor);
      if (at < 0 || source.letters.indexOf(anchor, at + 1) >= 0) continue;
      const after = at + tailWidth;
      let text = source.text.slice(source.spans[after - 1]!.end);
      // A box reaching into the next blocks ends the missing tail where their prose begins.
      text = text.slice(0, ownedFrom(text)).trimEnd();
      const missing = mapLetters(text).letters.length;
      if (missing < 8 || missing > 500) continue;
      if ((stripMarkup(text).match(/[A-Za-z]{2,}/g)?.length ?? 0) < 2 || !preservesNumbers(tail, text)) continue;
      candidates.add(text);
    }
    if (candidates.size === 1) edits.push({ start, end: cloud.length, text: [...candidates][0]! });
  }
  let result = cloud;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

function preservesNumbers(original: string, candidate: string): boolean {
  const numbers: string[] = stripMarkup(candidate).match(/\d+/g) ?? [];
  let position = 0;
  return (stripMarkup(original).match(/\d+/g) ?? []).every(number => {
    const at = numbers.indexOf(number, position);
    position = at + 1;
    return at >= 0;
  });
}

/** Locate visible letters while retaining offsets into the original inline markup. */
function mapLetters(value: string, includeNumbers = false): LetterMap {
  const spans: LetterMap['spans'] = [];
  let letters = '';
  const tokens = /<[^>]*>|&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:\d+|x[\da-f]+);|\\(?:mathrm|mathbf|mathsf|operatorname|mathit|text|left|right)\b|./gisu;
  for (const token of value.matchAll(tokens)) {
    const original = token[0];
    if (/^(?:<|&|\\)/.test(original)) continue;
    for (const letter of original.normalize('NFKC')) {
      if (!(includeNumbers ? /[A-Za-z0-9]/ : /[A-Za-z]/).test(letter)) continue;
      letters += letter.toLowerCase();
      spans.push({start:token.index,end:token.index+original.length});
    }
  }
  return {letters,spans};
}

/** Only baseline prose and word boundaries proven by a unique regional match are changed. */
function restoreVerifiedTypography(cloud: string, regions: string[]): string {
  let mapped = mapLetters(cloud, true);
  const native = regions.filter(Boolean).map(text => ({
    text, ...mapLetters(text, true),
    scripts: [...text.matchAll(/<(?:sup|sub)\b[^>]*>[\s\S]*?<\/(?:sup|sub)>/gi)],
  }));
  const evidence = (first: number, last: number) => {
    const left = Math.max(0, Math.min(first - 24, mapped.letters.length - 48));
    const right = Math.min(mapped.letters.length, Math.max(last + 25, left + 48));
    const needle = mapped.letters.slice(left, right);
    if (needle.length < 48) return [];
    return native.flatMap(source => {
      const at = source.letters.indexOf(needle);
      if (at < 0 || source.letters.indexOf(needle, at + 1) >= 0) return [];
      return [{ source, first: source.spans[at + first - left]!, last: source.spans[at + last - left]!,
        contextStart: source.spans[at]!.start, contextEnd: source.spans[at + needle.length - 1]!.end }];
    });
  };
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const formulas = [...cloud.matchAll(/(?<!\\)\$\$?[\s\S]*?(?<!\\)\$\$?/g)];
  for (const run of cloud.matchAll(/(?:<sup\b[^>]*>[^<>]*<\/sup>[\s∼~]*)+/gi)) {
    if ((stripMarkup(run[0]).match(/[A-Za-z]{2,}/g)?.length ?? 0) < 2) continue;
    const start = run.index, end = start + run[0].length;
    if (formulas.some(formula => start < formula.index + formula[0].length && end > formula.index)) continue;
    const first = mapped.spans.findIndex(span => span.start >= start);
    const last = mapped.spans.findLastIndex(span => span.end <= end);
    if (first < 0 || last < first) continue;
    const matches = evidence(first, last);
    if (!matches.length || matches.some(match => match.source.scripts.some(script =>
      match.first.start < script.index + script[0].length && match.last.end > script.index))) continue;
    edits.push({ start, end, text: run[0].replace(/<\/?sup\b[^>]*>/gi, '') });
  }
  let result = cloud;
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);

  mapped = mapLetters(result, true);
  edits.length = 0;
  const protectedMath = [...result.matchAll(/(?<!\\)\$\$?[\s\S]*?(?<!\\)\$\$?/g)];
  for (let index = 1; index < mapped.letters.length; index++) {
    if (!/^[a-z]{2}$/.test(mapped.letters.slice(index - 1, index + 1))) continue;
    const start = mapped.spans[index - 1]!.end, end = mapped.spans[index]!.start;
    const gap = result.slice(start, end);
    if (!/^\s*$/.test(gap) || protectedMath.some(math => start < math.index + math[0].length && end > math.index)) continue;
    const candidates = new Set(evidence(index - 1, index).flatMap(match => {
      const nativeGap = match.source.text.slice(match.first.end, match.last.start);
      if (!nativeGap && gap) {
        // A native font run with no spaces cannot prove the boundaries of its individual words.
        const wordStart = match.source.text.slice(0, match.first.end).search(/[A-Za-z]+$/);
        const wordEnd = match.last.start + (match.source.text.slice(match.last.start).match(/^[A-Za-z]+/)?.[0].length ?? 0);
        if (wordStart < match.contextStart || wordEnd > match.contextEnd) return [];
      }
      return /^\s*$/.test(nativeGap) ? [nativeGap ? ' ' : ''] : [];
    }));
    if (candidates.size !== 1) continue;
    const text = [...candidates][0]!;
    if (gap && !text && isCompoundUnitGap(result, start, end)) continue;
    if (Boolean(gap) !== Boolean(text)) edits.push({ start, end, text });
  }
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

const UNIT_SYMBOL = /^(?:da|[qryzafpnumµμcdhkMGTPEZYRQ])?(?:m|s|g|A|K|mol|cd|Hz|N|Pa|J|W|C|V|F|Ω|S|Wb|T|H|L|l|eV|bar|min)$/u;
const UNIT_POWER = /^\s*(?:[⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+|<sup\b[^>]*>\s*[+\-−]?\s*\d+\s*<\/sup>|\$?\^\s*(?:{\s*[+\-−]?\s*\d+\s*}|[+\-−]?\d+))/i;

function isCompoundUnitGap(text: string, start: number, end: number): boolean {
  const before = text.slice(0, start);
  const left = /[\p{L}]+$/u.exec(before)?.[0];
  const right = /^[\p{L}]+/u.exec(text.slice(end))?.[0];
  if (!left || !right || !UNIT_SYMBOL.test(left) || !UNIT_SYMBOL.test(right)) return false;
  return /\d$/.test(before.slice(0, -left.length).trimEnd()) || UNIT_POWER.test(text.slice(end + right.length));
}

interface LigatureMap extends LetterMap {
  widths: number[];
}

/** Collapse only a two-f glyph run, retaining offsets and its native width. */
function mapLigatureLetters(value: string): LigatureMap {
  const mapped = mapLetters(value);
  const result: LigatureMap = {letters:'',spans:[],widths:[]};
  const joined = (left: number, right: number) =>
    !stripMarkup(value.slice(mapped.spans[left]!.end,mapped.spans[right]!.start)).length;
  for (let index = 0; index < mapped.letters.length; index++) {
    const doubled = mapped.letters.slice(index,index+2) === 'ff' && joined(index,index+1) &&
      !(mapped.letters[index-1] === 'f' && joined(index-1,index)) &&
      !(mapped.letters[index+2] === 'f' && joined(index+1,index+2));
    result.letters += mapped.letters[index];
    result.spans.push({start:mapped.spans[index]!.start,end:mapped.spans[index+(doubled ? 1 : 0)]!.end});
    result.widths.push(doubled ? 2 : 1);
    if (doubled) index++;
  }
  return result;
}

interface NativeSpan {start:number;end:number}

function findNativeSpans(cloud: string, regional: string): NativeSpan[] {
  const native = mapLigatureLetters(regional);
  if (native.widths.reduce((total,width)=>total+width,0) < 80) return [];
  const mapped = mapLigatureLetters(cloud);
  const spans: NativeSpan[] = [];
  for (let index = mapped.letters.indexOf(native.letters); index >= 0; index = mapped.letters.indexOf(native.letters,index+1)) {
    // Only native ff/ffi/ffl may lose one f in cloud extraction.
    if (native.widths.some((width,offset) => mapped.widths[index+offset]! > width)) continue;
    spans.push({start:mapped.spans[index]!.start,end:mapped.spans[index+native.letters.length-1]!.end});
    if (spans.length > 1) break;
  }
  return spans;
}

function countContinuationMatches(cloud: string, regional: string, fragment: string, nativeLetters: string): number {
  const compact = compactText(cloud);
  const first = compact.indexOf(fragment);
  const exact = first < 0 ? 0 : compact.indexOf(fragment, first + 1) < 0 ? 1 : 2;
  if (!nativeLetters || exact === 2) return exact;

  const spans = findNativeSpans(cloud, regional);
  if (exact || spans.length) return Math.max(exact, spans.length);

  // Long continuations can contain OCR differences between independently verified ends.
  const width = 48;
  const letters = mapLigatureLetters(cloud).letters;
  if (nativeLetters.length >= width * 2) {
    const head = nativeLetters.slice(0, width), tail = nativeLetters.slice(-width);
    const start = letters.indexOf(head), end = letters.indexOf(tail);
    if (start >= 0 && end >= start + width && letters.indexOf(head, start + 1) < 0 && letters.indexOf(tail, end + 1) < 0 &&
      Math.abs(end + width - start - nativeLetters.length) <= Math.ceil(nativeLetters.length * 0.02)) return 1;
  }
  return countAnchoredContinuationMatches(letters, nativeLetters);
}

const CONTINUATION_ANCHOR = 35;

function countAnchoredContinuationMatches(cloud: string, native: string): number {
  if (native.length < CONTINUATION_ANCHOR * 2) return 0;
  const head = native.slice(0, CONTINUATION_ANCHOR);
  const regionalTail = native.slice(CONTINUATION_ANCHOR);
  const budget = Math.ceil(native.length * 0.1);
  let count = 0;
  for (let start = cloud.indexOf(head); start >= 0; start = cloud.indexOf(head, start + 1)) {
    const candidateTail = cloud.slice(start + CONTINUATION_ANCHOR);
    if (matchesContinuationWithEdits(regionalTail, candidateTail, budget) || hasVerifiedOmission(regionalTail, candidateTail)) {
      count++;
      if (count > 1) break;
    }
  }
  return count;
}

/** Match the regional text to a prefix after the exact anchor, allowing PDF and TeX spelling differences. */
function matchesContinuationWithEdits(regional: string, candidate: string, budget: number): boolean {
  const minimumLength = regional.length - budget;
  const maximumLength = Math.min(candidate.length, regional.length + budget);
  if (maximumLength < minimumLength) return false;

  let previous = new Uint32Array(maximumLength + 1);
  let current = new Uint32Array(maximumLength + 1);
  for (let column = 0; column <= Math.min(budget + 1, maximumLength); column++) previous[column] = column;
  for (let row = 1; row <= regional.length; row++) {
    const first = Math.max(1, row - budget);
    const last = Math.min(maximumLength, row + budget);
    // Exclude stale cells just outside the edit band.
    current[first - 1] = first === 1 ? row : budget + 1;
    if (last < maximumLength) current[last + 1] = budget + 1;
    for (let column = first; column <= last; column++) {
      const substitution = previous[column - 1]! + Number(regional[row - 1] !== candidate[column - 1]);
      current[column] = Math.min(substitution, previous[column]! + 1, current[column - 1]! + 1);
    }
    [previous, current] = [current, previous];
  }
  return previous.subarray(minimumLength).some(edits => edits <= budget);
}

/** A missing interior can prove provenance when both ends and the remaining letters agree in order. */
function hasVerifiedOmission(regional: string, candidate: string): boolean {
  const endAnchor = regional.slice(-CONTINUATION_ANCHOR);
  const end = candidate.indexOf(endAnchor);
  if (end < 0 || candidate.indexOf(endAnchor, end + 1) >= 0) return false;
  const retained = end + CONTINUATION_ANCHOR * 2;
  const regionalLength = regional.length + CONTINUATION_ANCHOR;
  if (retained * 2 < regionalLength || retained >= regionalLength) return false;
  let cursor = 0;
  const limit = regional.length - CONTINUATION_ANCHOR;
  for (const letter of candidate.slice(0, end)) {
    cursor = regional.indexOf(letter, cursor);
    if (cursor < 0 || cursor >= limit) return false;
    cursor++;
  }
  return true;
}

/** Count cloud positions holding the native letters minus a few isolated single letters, never added or changed ones. */
function countDroppedLetterMatches(cloud: string, native: string): number {
  const allowed = Math.max(1, Math.floor(native.length / 200));
  let count = 0;
  for (let start = cloud.indexOf(native.slice(0, 30)); start >= 0 && count < 2; start = cloud.indexOf(native.slice(0, 30), start + 1)) {
    let dropped = 0, j = start;
    for (let i = 0; i < native.length && dropped <= allowed; i++) {
      if (cloud[j] === native[i]) j++;
      else if (native[i + 1] !== undefined && cloud[j] === native[i + 1]) { dropped++; j++; i++; }
      else dropped = allowed + 1;
    }
    if (dropped <= allowed) count++;
  }
  return count;
}

function replaceUniqueNativeSpan(cloud: string, regional: string, span: NativeSpan): string | undefined {
  const native = mapLetters(regional);
  if (native.letters.length < 80) return undefined;
  let {start,end} = span;
  // An unfinished formula boundary cannot be replaced without changing nearby
  // math. Fully enclosed formulas inside the proven span are native evidence.
  for (const math of cloud.matchAll(/(?<!\\)\$\$?[\s\S]*?(?<!\\)\$\$?/g)) {
    const left = math.index;
    const right = left+math[0].length;
    if ((start > left && start < right) || (end > left && end < right)) return undefined;
  }
  const nativeLeading = regional.slice(0,native.spans[0]!.start);
  if (/<(?:sup|sub)\b/i.test(nativeLeading)) {
    const leading = cloud.slice(0,start).match(/<(?:sup|sub)\b[^>]*>[\d\s,.†‡*⁎–−-]+<\/(?:sup|sub)>\s*$/i);
    if (leading) start-=leading[0].length;
  }
  // Consume the source span's own trailing indices/citations/punctuation while
  // leaving following whitespace, prose, and formulas in place.
  const trailing = cloud.slice(end).match(/^(?:(?:<\/(?:sup|sub)>|<(?:sup|sub)\b[^>]*>[\d\s,.†‡*⁎–−-]+<\/(?:sup|sub)>|\[[\d\s,.–−-]+\]|[\d.!?,;:])+)/i)?.[0];
  if (trailing) end+=trailing.length;
  return cloud.slice(0,start)+regional+cloud.slice(end);
}

function connectedSources(left: SourceRef[], right: SourceRef[]): boolean {
  return left.some(a => right.some(b => {
    if (Math.abs(a.page - b.page) === 1) return true;
    if (a.page !== b.page || !a.bbox || !b.bbox) return false;
    const horizontalGap = Math.max(0, a.bbox[0] - b.bbox[2], b.bbox[0] - a.bbox[2]);
    const verticalGap = Math.max(0, a.bbox[1] - b.bbox[3], b.bbox[1] - a.bbox[3]);
    return (horizontalGap > 0 && horizontalGap <= 0.08) || (verticalGap <= 0.04 && horizontalGap === 0);
  }));
}

function mergeSources(owner: ReaderBlock, sources: SourceRef[]): void {
  for (const source of sources) {
    if (!owner.sources.some(existing => existing.page === source.page && JSON.stringify(existing.bbox) === JSON.stringify(source.bbox))) {
      owner.sources.push(source);
    }
  }
}

function stripMarkup(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:\d+|x[\da-f]+);/gi, ' ').normalize('NFKC');
}

function compactText(value: string): string {
  return stripMarkup(value)
    .replace(/\\(?:mathrm|mathbf|mathsf|operatorname|mathit|text|left|right)\b/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function plainLetters(value: string): string {
  return stripMarkup(value).replace(/[^A-Za-z]/g, '').toLowerCase();
}

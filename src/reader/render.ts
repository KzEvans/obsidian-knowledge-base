import { finishRenderMath, loadMathJax, renderMath, sanitizeHTMLToDom } from 'obsidian';
import type { ReaderBlock, Segment } from '../core/types';

export type Language = 'en' | 'zh';
/** A stored block, or a plain ReaderBlock without translation units. */
export type RenderBlock = ReaderBlock & { segments?: readonly Segment[] };

export interface ReaderRenderOptions {
  fontSize: number;
  lineHeight: number;
  /** URL for a block's `asset` reference (a key of document.assets). */
  assetUrl: (reference: string) => string;
  assetDimensions?: (reference: string) => { width: number; height: number } | undefined;
  /**
   * Chinese text for a segment's sourceHash. When this is absent no Chinese layers
   * are built at all (translation not started); updateTranslations() adds them later.
   */
  translation?: (sourceHash: string) => string | undefined;
  language?: Language;
  isCurrent?: () => boolean;
  onSource: (page: number) => void;
  onCopy: (page: number) => void;
  onZoom: (url: string, caption: string) => void;
}

interface RenderContext {
  document: Document;
  options: ReaderRenderOptions;
  markedPages: Set<number>;
  mathDocuments: Set<Document>;
  pendingMath: Set<MathTemplate>;
}

interface MathTemplate { element: HTMLElement; flushed: boolean; scopeIds: boolean }
const MATH_TEMPLATE_LIMIT = 512;
const mathTemplates = new WeakMap<Document, Map<string, MathTemplate>>();
let mathInstance = 0;

type Tag = keyof HTMLElementTagNameMap;

const INLINE_TAGS = new Set(['SPAN', 'SUP', 'SUB', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'SMALL', 'BR', 'CODE']);
const TABLE_TAGS = new Set(['TABLE', 'CAPTION', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'UL', 'OL', 'LI', 'P', 'DIV']);
const OMIT_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'TEXTAREA', 'BUTTON', 'SVG', 'MATH']);
const HIDDEN_LAYER = '.pw-layer[aria-hidden="true"]';
/** Marks reader UI inside the reading layer, so selection and copy can drop it (contracts §6.1). */
const UI = { 'data-pw-ui': '' };

/** Keep body/figure order, moving only ancillary blocks to the end of their section. */
export async function renderReader(root: HTMLElement, blocks: readonly RenderBlock[], options: ReaderRenderOptions): Promise<void> {
  if (options.isCurrent?.() === false) return;
  if (blocks.some(requiresMath)) {
    try { await loadMathJax(); } catch { /* Individual formulas retain their source-page fallback. */ }
  }
  if (options.isCurrent?.() === false) return;
  const context: RenderContext = { document: root.ownerDocument, options, markedPages: new Set(), mathDocuments: new Set(), pendingMath: new Set() };
  setTypography(root, options.fontSize, options.lineHeight);
  root.dataset.lang = options.language ?? 'en';
  root.empty();
  const article = root.createEl('article', { cls: 'pdf-reader-article', attr: { 'aria-label': 'PDF 阅读模式正文' } });

  const batch = batcher();
  const ordered = sectionEndAncillary(blocks);
  for (let index = 0; index < ordered.length;) {
    const block = ordered[index];
    if (!block) break;
    const fold = foldKind(block);
    if (!fold) {
      renderBlock(article, block, context);
      index += 1;
      if (batch.due()) {
        await batch.yield();
        if (options.isCurrent?.() === false) return;
      }
      continue;
    }

    const group: RenderBlock[] = [];
    while (index < ordered.length) {
      const next = ordered[index];
      if (!next || foldKind(next) !== fold) break;
      group.push(next);
      index += 1;
    }
    const details = article.createEl('details', { cls: 'pdf-reader-fold', attr: { 'data-fold-kind': fold } });
    const summary = details.createEl('summary', { cls: 'pdf-reader-fold-summary', text: foldLabel(fold), attr: UI });
    setSources(summary, group.flatMap(item => sourcePages(item)));
    const content = details.createDiv({ cls: 'pdf-reader-fold-content' });
    const foldedContext = { ...context, markedPages: new Set<number>() };
    for (const item of group) {
      renderBlock(content, item, foldedContext);
      if (batch.due()) {
        await batch.yield();
        if (options.isCurrent?.() === false) return;
      }
    }
  }

  if (!blocks.length) article.createEl('p', { cls: 'pdf-reader-render-notice', text: '没有可重排的正文，请查看原 PDF。', attr: UI });
  setLanguage(root, root.dataset.lang === 'zh' ? 'zh' : 'en');
  await flushMath(context, () => {
    if (article.isConnected && article.parentElement === root) {
      article.createEl('p', { cls: 'pdf-reader-render-notice', text: '部分公式未完成排版，可用原文按钮查看源页。', attr: UI, prepend: true });
    }
  });
}

export function setTypography(root: HTMLElement, fontSize: number, lineHeight: number): void {
  root.style.setProperty('--pdf-reader-font-size', `${finiteClamp(fontSize, 14, 30, 18)}px`);
  root.style.setProperty('--pdf-reader-line-height', String(finiteClamp(lineHeight, 1.2, 2, 1.5)));
}

/**
 * Switch the visible layer. Both layers share one grid cell, so this changes no block
 * size: CSS keys off the root's data-lang; aria-hidden follows for assistive tech,
 * search and copy.
 */
export function setLanguage(root: HTMLElement, language: Language): void {
  root.dataset.lang = language;
  root.querySelectorAll<HTMLElement>('.pw-block').forEach(block => {
    const layers = Array.from(block.children).filter((child): child is HTMLElement => child.classList.contains('pw-layer'));
    for (const layer of layers) {
      if (layers.length > 1 && layer.getAttribute('lang') !== language) layer.setAttribute('aria-hidden', 'true');
      else layer.removeAttribute('aria-hidden');
    }
  });
}

/**
 * Build or refresh Chinese layers after translations arrive while the reader is open.
 * Returns how many layers changed. Yields between batches like the first render.
 */
export async function updateTranslations(root: HTMLElement, blocks: readonly RenderBlock[], translation: (sourceHash: string) => string | undefined, options: Pick<ReaderRenderOptions, 'isCurrent'> = {}): Promise<number> {
  const sources = new Map<string, { text: string; list: boolean }>();
  for (const block of blocks) {
    for (const segment of block.segments ?? []) {
      const text = segment.field === 'text' ? block.text : segment.field === 'caption' ? block.captions?.[segment.index] : block.footnotes?.[segment.index];
      if (text !== undefined) sources.set(segment.sourceHash, { text, list: segment.field === 'text' && block.kind === 'list' });
    }
  }
  const pending = Array.from(root.querySelectorAll<HTMLElement>('.pw-block[data-segment]')).filter(block => {
    const hash = block.dataset.segment ?? '';
    const zh = chineseLayer(block);
    return !zh || renderedTranslation.get(zh) !== (translation(hash) ?? null);
  });
  if (!pending.length) return 0;
  const texts = pending.map(block => translation(block.dataset.segment ?? '') ?? '');
  if (texts.some(text => mathPattern().test(text))) {
    try { await loadMathJax(); } catch { /* Fallback code spans remain. */ }
  }
  const context: RenderContext = {
    document: root.ownerDocument, markedPages: new Set(), mathDocuments: new Set(), pendingMath: new Set(),
    options: { fontSize: 0, lineHeight: 0, assetUrl: () => '', onSource: () => {}, onCopy: () => {}, onZoom: () => {}, translation, ...options },
  };
  const batch = batcher();
  let changed = 0;
  for (const block of pending) {
    if (options.isCurrent?.() === false) return changed;
    const hash = block.dataset.segment ?? '';
    const source = sources.get(hash);
    if (!source) continue;
    chineseLayer(block)?.remove();
    appendChineseLayer(block, hash, source.text, source.list, context);
    changed++;
    if (batch.due()) await batch.yield();
  }
  setLanguage(root, root.dataset.lang === 'zh' ? 'zh' : 'en');
  await flushMath(context, () => {});
  return changed;
}

/** Candidate Chinese/English font-size ratios for the single Chinese size. */
export const ZH_SCALES = Array.from({ length: 13 }, (_, index) => Math.round((0.8 + index * 0.025) * 1000) / 1000);

/** The scale whose summed |English − Chinese| layer height over the samples is smallest. */
export function chooseZhScale(candidates: readonly number[], heights: (scale: number) => Array<[english: number, chinese: number]>): number | undefined {
  let best: number | undefined;
  let bestError = Infinity;
  for (const scale of candidates) {
    const pairs = heights(scale);
    if (!pairs.length) return undefined;
    const error = pairs.reduce((total, [english, chinese]) => total + Math.abs(english - chinese), 0);
    if (error < bestError - 1e-9) { best = scale; bestError = error; }
  }
  return best;
}

/**
 * Measure once on a sample of translated paragraphs, in an off-flow copy so the
 * visible document reflows only once when the chosen value is applied.
 */
export function measureZhScale(root: HTMLElement, maxSamples = 16): number | undefined {
  const article = root.querySelector<HTMLElement>('.pdf-reader-article');
  if (!article) return undefined;
  const translated = Array.from(root.querySelectorAll<HTMLElement>('.pdf-reader-paragraph .pw-block'))
    .filter(block => { const zh = chineseLayer(block); return zh && !zh.classList.contains('is-untranslated'); });
  if (!translated.length) return undefined;
  const step = Math.max(1, translated.length / maxSamples);
  const samples: HTMLElement[] = [];
  for (let index = 0; index < translated.length && samples.length < maxSamples; index += step) samples.push(translated[Math.floor(index)]!);
  const measure = article.createDiv({ cls: 'pw-measure', attr: { 'aria-hidden': 'true' } });
  try {
    const clones = samples.map(sample => {
      const paragraph = measure.createEl('p');
      const clone = sample.cloneNode(true) as HTMLElement;
      paragraph.append(clone);
      return clone;
    });
    return chooseZhScale(ZH_SCALES, scale => {
      measure.style.setProperty('--pw-zh-scale', String(scale));
      return clones.flatMap(clone => {
        const english = clone.querySelector<HTMLElement>('.pw-layer[lang="en"]');
        const chinese = chineseLayer(clone);
        return english && chinese ? [[english.getBoundingClientRect().height, chinese.getBoundingClientRect().height] as [number, number]] : [];
      });
    });
  } finally {
    measure.remove();
  }
}

export function setZhScale(root: HTMLElement, scale: number): void {
  root.style.setProperty('--pw-zh-scale', String(scale));
}

function requiresMath(block: ReaderBlock): boolean {
  if (block.kind === 'equation') return true;
  return [block.text, block.html ?? '', ...(block.captions ?? []), ...(block.footnotes ?? [])]
    .some(text => mathPattern().test(text) || /data-(?:math|latex)\s*=|math-(?:inline|display)/i.test(text));
}

export function scrollToSourcePage(root: HTMLElement, page: number): void {
  if (!Number.isInteger(page) || page < 1) return;
  const targets = Array.from(root.querySelectorAll<HTMLElement>('.pdf-reader-block[data-source-pages]'))
    .filter(element => pagesFromElement(element).includes(page));
  // Prefer the body when a page also contains a collapsed publisher header.
  const target = targets.find(element => !element.closest('.pdf-reader-fold') && pagesFromElement(element)[0] === page)
    ?? targets.find(element => !element.closest('.pdf-reader-fold'))
    ?? targets.find(element => element.closest('.pdf-reader-fold')?.getAttribute('data-fold-kind') === 'references')
    ?? targets[0];
  if (!target) return;
  for (let parent = target.parentElement; parent && parent !== root; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
  }
  const top = target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 24;
  root.scrollTop = Math.max(0, top);
}

const BREAK_AFTER = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'SECTION', 'FIGCAPTION', 'SUMMARY', 'TR']);

/**
 * Text a reader sees: no page markers, no source-tool buttons and no hidden
 * language layer. Used by in-reader search and by copy.
 */
export function readableText(node: Node): string {
  let text = '';
  const walk = (current: Node) => {
    for (const child of Array.from(current.childNodes)) {
      if (child.nodeType === 3) { text += child.textContent ?? ''; continue; }
      if (child.nodeType !== 1) continue;
      const element = child as HTMLElement;
      if (element.hasAttribute('data-pw-ui') || element.matches(HIDDEN_LAYER)) continue;
      walk(element);
      if (BREAK_AFTER.has(element.tagName)) text += '\n';
    }
  };
  walk(node);
  return text.replace(/[ \t]*\n[\s]*/g, '\n').trim();
}

/** Search text of one reader block, in the visible language only. */
export function blockSearchText(block: HTMLElement): string {
  return readableText(block);
}

/** Whether copying this fragment needs readableText() instead of the browser's own text. */
export function needsCleanCopy(fragment: ParentNode): boolean {
  return Boolean(fragment.querySelector(`${HIDDEN_LAYER}, [data-pw-ui]`));
}

export interface SourcePageTracker {
  getPage(): number | undefined;
  getStats(): { rebuilds: number; rebuildMs: number; invalidations: Record<string, number> };
  dispose(): void;
}

interface PagePosition { page: number; top: number; bottom: number }
interface PageIndex { positions: PagePosition[]; height: number }
const pageTrackers = new WeakMap<HTMLElement, SourcePageTracker>();

/** Cache geometry between layout changes; normal scrolling only reads scrollTop. */
export function createSourcePageTracker(root: HTMLElement, onChange: (page: number) => void): SourcePageTracker {
  pageTrackers.get(root)?.dispose();
  const win = root.ownerDocument.defaultView!;
  const requestFrame = (callback: FrameRequestCallback): number => typeof win.requestAnimationFrame === 'function'
    ? win.requestAnimationFrame(callback) : win.setTimeout(() => callback(0), 16);
  const cancelFrame = (id: number) => typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame(id) : win.clearTimeout(id);
  let index: PageIndex = { positions: [], height: 0 };
  let dirty = true;
  let frame: number | undefined;
  let disposed = false;
  let previousPage: number | undefined;
  let rebuilds = 0;
  let rebuildMs = 0;
  const invalidations: Record<string, number> = {};
  const getPage = (): number | undefined => {
    if (disposed) return undefined;
    if (dirty) {
      const started = performance.now();
      index = buildPageIndex(root);
      rebuilds++;
      rebuildMs += performance.now() - started;
      dirty = index.height <= 0;
    }
    return pageAtScroll(index, root.scrollTop);
  };
  const schedule = () => {
    if (disposed || frame !== undefined) return;
    frame = requestFrame(() => {
      frame = undefined;
      const page = getPage();
      if (page !== undefined && page !== previousPage) { previousPage = page; onChange(page); }
    });
  };
  const invalidate = (reason: string) => {
    if (disposed) return;
    invalidations[reason] = (invalidations[reason] ?? 0) + 1;
    dirty = true;
    schedule();
  };
  const toggle = () => invalidate('toggle');
  const error = () => invalidate('error');
  const windowResize = () => invalidate('window-resize');
  const imageLoad = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (target?.tagName === 'IMG' && target.dataset.readerLayoutReserved !== 'true') invalidate('load');
  };
  const resize = win.ResizeObserver ? new win.ResizeObserver(() => invalidate('resize-observer')) : undefined;
  resize?.observe(root);
  const article = root.querySelector('article');
  if (article) resize?.observe(article);
  root.addEventListener('scroll', schedule, { passive: true });
  root.addEventListener('toggle', toggle, true);
  root.addEventListener('load', imageLoad, true);
  root.addEventListener('error', error, true);
  win.addEventListener('resize', windowResize);
  const tracker: SourcePageTracker = {
    getPage,
    getStats: () => ({ rebuilds, rebuildMs, invalidations: { ...invalidations } }),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame !== undefined) cancelFrame(frame);
      resize?.disconnect();
      root.removeEventListener('scroll', schedule);
      root.removeEventListener('toggle', toggle, true);
      root.removeEventListener('load', imageLoad, true);
      root.removeEventListener('error', error, true);
      win.removeEventListener('resize', windowResize);
      if (pageTrackers.get(root) === tracker) pageTrackers.delete(root);
    },
  };
  pageTrackers.set(root, tracker);
  return tracker;
}

export function getVisibleSourcePage(root: HTMLElement): number | undefined {
  const tracker = pageTrackers.get(root);
  return tracker ? tracker.getPage() : pageAtScroll(buildPageIndex(root), root.scrollTop);
}

function buildPageIndex(root: HTMLElement): PageIndex {
  const boundary = root.getBoundingClientRect();
  const positions: PagePosition[] = [];
  const elements = Array.from(root.querySelectorAll<HTMLElement>('.pdf-reader-block[data-source-pages], .pdf-reader-fold-summary[data-source-pages]'));
  for (const element of elements) {
    const closedFold = element.closest('details:not([open])');
    if (closedFold && element.parentElement !== closedFold) continue;
    const rectangle = element.getBoundingClientRect();
    if (rectangle.height <= 0 || rectangle.width <= 0) continue;
    const page = pagesFromElement(element)[0];
    if (!page) continue;
    positions.push({ page, top: rectangle.top - boundary.top + root.scrollTop, bottom: rectangle.bottom - boundary.top + root.scrollTop });
  }
  positions.sort((left, right) => left.top - right.top);
  return { positions, height: boundary.height };
}

function pageAtScroll(index: PageIndex, scrollTop: number): number | undefined {
  if (index.height <= 0 || !index.positions.length) return undefined;
  const line = scrollTop + Math.min(48, index.height / 4);
  let low = 0;
  let high = index.positions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (index.positions[middle]!.top <= line) low = middle + 1;
    else high = middle;
  }
  const before = index.positions[low - 1];
  const after = index.positions[low];
  if (before && before.bottom > line) return before.page;
  const beforeVisible = before && before.bottom > scrollTop;
  const afterVisible = after && after.top < scrollTop + index.height;
  if (beforeVisible && (!afterVisible || line - before.top <= after.top - line)) return before.page;
  return afterVisible ? after.page : undefined;
}

function renderBlock(parent: HTMLElement, block: RenderBlock, context: RenderContext): void {
  const wrapper = parent.createEl('section', { cls: `pdf-reader-block pdf-reader-${block.kind}`, attr: { 'data-reader-block-id': block.id } });
  const pages = sourcePages(block);
  setSources(wrapper, pages);
  const unmarkedPages = pages.filter(page => !context.markedPages.has(page));
  if (unmarkedPages.length) {
    const markers = wrapper.createDiv({ cls: 'pdf-reader-page-markers', attr: UI });
    for (const page of unmarkedPages) {
      context.markedPages.add(page);
      markers.createSpan({ cls: 'pdf-reader-page-marker', text: `PDF p. ${page}` });
    }
  }

  if (block.kind === 'figure' || block.kind === 'table') {
    const figure = wrapper.createEl('figure', { cls: 'pdf-reader-figure-group' });
    // Tables use an original-PDF crop; provider HTML cannot change columns or scientific notation.
    appendImageOrText(figure, block, context);
    appendCaptions(figure, block, context);
  } else if (block.kind === 'equation') {
    const equation = wrapper.createDiv({ cls: 'pdf-reader-equation-body' });
    const rendered = appendMath(equation, stripMathDelimiters(block.text), true, context);
    const original = !rendered && block.asset ? resolveAsset(block.asset, context.options) : undefined;
    if (original) {
      equation.empty();
      appendImage(equation, original, block.text || '原文公式', context, undefined, block.asset);
    }
    appendCaptions(wrapper, block, context);
  } else if (block.kind === 'list') {
    appendLayers(wrapper, 'div', segmentFor(block, 'text', 0), block.text, true, context, layer => {
      if (block.html) appendHtml(layer, block.html, context, true, block.text);
      else appendList(layer, block.text, context);
    });
  } else {
    const level = Math.round(finiteClamp(block.level ?? 2, 1, 6, 2));
    const element = wrapper.createEl((block.kind === 'heading' ? `h${level}` : 'p') as Tag);
    const segment = TEXT_KINDS.has(block.kind) ? segmentFor(block, 'text', 0) : undefined;
    appendLayers(element, 'span', segment, block.text, false, context, layer => {
      if (block.html) appendHtml(layer, block.html, context, false, block.text);
      else appendTextWithMath(layer, block.text, context);
    });
  }

  if (wrapper.querySelector('.pdf-reader-math-fallback')) wrapper.addClass('has-math-fallback');
  appendSourceTools(wrapper, pages, context);
}

const TEXT_KINDS = new Set<ReaderBlock['kind']>(['paragraph', 'heading', 'list', 'footnote']);

function segmentFor(block: RenderBlock, field: Segment['field'], index: number): Segment | undefined {
  return block.segments?.find(segment => segment.field === field && segment.index === index);
}

/**
 * Without a translation unit the content goes straight into `parent`, as before.
 * With one, English and Chinese share one grid cell (architecture §6.2), so the
 * block is as tall as the taller layer whichever is shown.
 */
function appendLayers(parent: HTMLElement, tag: 'div' | 'span', segment: Segment | undefined, source: string, list: boolean, context: RenderContext, english: (layer: HTMLElement) => void): void {
  if (!segment) { english(parent); return; }
  const block = parent.createEl(tag, { cls: 'pw-block', attr: { 'data-segment': segment.sourceHash } });
  english(block.createEl(tag, { cls: 'pw-layer', attr: { lang: 'en' } }));
  if (context.options.translation) appendChineseLayer(block, segment.sourceHash, source, list, context);
}

const renderedTranslation = new WeakMap<HTMLElement, string | null>();

function appendChineseLayer(block: HTMLElement, hash: string, source: string, list: boolean, context: RenderContext): void {
  const text = context.options.translation?.(hash);
  const layer = block.createEl(block.tagName === 'DIV' ? 'div' : 'span', { cls: 'pw-layer', attr: { lang: 'zh' } });
  renderedTranslation.set(layer, text ?? null);
  if (!text) {
    // Show the English source in place, with a light marker, so the block keeps its place.
    layer.addClass('is-untranslated');
    layer.setAttribute('title', '暂无译文');
    layer.createSpan({ cls: 'pw-untranslated-mark', attr: { ...UI, 'aria-hidden': 'true' } });
  }
  if (list) appendList(layer, text ?? source, context);
  else appendTextWithMath(layer, text ?? source, context);
}

function chineseLayer(block: HTMLElement): HTMLElement | undefined {
  return Array.from(block.children).find((child): child is HTMLElement => child.classList.contains('pw-layer') && child.getAttribute('lang') === 'zh');
}

function appendList(parent: HTMLElement, text: string, context: RenderContext): void {
  const lines = text.split(/\n+/).filter(line => line.trim());
  const ordered = lines.length > 0 && lines.every(line => /^\s*\d+[.)]\s/.test(line));
  const list = parent.createEl(ordered ? 'ol' : 'ul');
  for (const line of lines) appendTextWithMath(list.createEl('li'), line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''), context);
}

function appendImageOrText(parent: HTMLElement, block: RenderBlock, context: RenderContext): void {
  const url = block.asset ? resolveAsset(block.asset, context.options) : undefined;
  if (url) {
    const caption = displayCaptions(block).join('\n');
    appendImage(parent, url, caption, context, block.text || caption, block.asset);
    return;
  }
  parent.createEl('p', { cls: 'pdf-reader-render-notice', text: block.kind === 'table' ? '原 PDF 表格裁图暂不可用，请查看源页。' : '图表暂不可用，请查看源页。', attr: UI });
}

function appendImage(parent: HTMLElement, url: string, caption: string, context: RenderContext, altText?: string, assetReference?: string): void {
  const image = parent.createEl('img', { cls: 'pdf-reader-image', attr: { role: 'button', 'aria-label': '放大查看图表' } });
  image.alt = (altText ?? caption).trim().slice(0, 300) || '文献图表';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.tabIndex = 0;
  const setDimensions = (width: number, height: number): boolean => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
    image.setAttribute('width', String(width));
    image.setAttribute('height', String(height));
    image.style.aspectRatio = `${width} / ${height}`;
    return true;
  };
  const dimensions = assetReference ? context.options.assetDimensions?.(assetReference) : undefined;
  if (dimensions && setDimensions(dimensions.width, dimensions.height)) image.dataset.readerLayoutReserved = 'true';
  image.addEventListener('load', () => {
    if (!image.hasAttribute('width') || !image.hasAttribute('height')) setDimensions(image.naturalWidth, image.naturalHeight);
  }, { once: true });
  image.addEventListener('click', () => context.options.onZoom(url, caption));
  image.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      context.options.onZoom(url, caption);
    }
  });
  image.addEventListener('error', () => {
    image.hidden = true;
    const warning = parent.createEl('p', { cls: 'pdf-reader-render-notice', text: '图表无法加载，请查看源页。', attr: UI });
    image.after(warning);
  }, { once: true });
  image.src = url;
}

function appendCaptions(parent: HTMLElement, block: RenderBlock, context: RenderContext): void {
  const captions = displayCaptions(block);
  if (captions.length) {
    const caption = parent.createEl('figcaption');
    // A fallback caption taken from the block text has no translation unit.
    const own = Boolean(block.captions?.length);
    captions.forEach((text, index) => {
      const paragraph = caption.createEl('p');
      appendLayers(paragraph, 'span', own ? segmentFor(block, 'caption', index) : undefined, text, false, context, layer => appendTextWithMath(layer, text, context));
    });
  }
  if (block.footnotes?.length) {
    const notes = parent.createDiv({ cls: 'pdf-reader-figure-footnotes' });
    block.footnotes.forEach((text, index) => {
      const paragraph = notes.createEl('p');
      appendLayers(paragraph, 'span', segmentFor(block, 'footnote', index), text, false, context, layer => appendTextWithMath(layer, text, context));
    });
  }
}

function displayCaptions(block: ReaderBlock): string[] {
  if (block.captions?.length) return block.captions;
  // A figure's text is often OCR from axes/panels. Retain it only when it is clearly a caption.
  const text = block.text.replace(/<[^>]*>/g, '').trim();
  if (block.kind === 'figure' && /^(?:fig(?:ure)?\.?\s*(?:s?\d+[a-z]?|[ivx]+)\b|图\s*(?:\d+|[一二三四五六七八九十]+))/i.test(text)) return [block.text];
  return [];
}

function sectionEndAncillary(blocks: readonly RenderBlock[]): RenderBlock[] {
  const ordered: RenderBlock[] = [];
  let ancillary: RenderBlock[] = [];
  for (const block of blocks) {
    if (block.kind === 'metadata' || block.kind === 'header' || block.kind === 'footer') {
      if (block.text.trim() || block.html?.trim() || block.asset || block.captions?.length || block.footnotes?.length) ancillary.push(block);
      continue;
    }
    if (block.kind === 'heading') {
      ordered.push(...ancillary);
      ancillary = [];
    }
    ordered.push(block);
  }
  // Keep the final references fold last; its repeated page furniture belongs just before it.
  let referencesStart = ordered.length;
  while (referencesStart > 0) {
    const previous = ordered[referencesStart - 1];
    if (!previous || foldKind(previous) !== 'references') break;
    referencesStart -= 1;
  }
  if (referencesStart < ordered.length) ordered.splice(referencesStart, 0, ...ancillary);
  else ordered.push(...ancillary);
  return ordered;
}

function appendSourceTools(parent: HTMLElement, pages: number[], context: RenderContext): void {
  if (!pages.length) return;
  const tools = parent.createDiv({ cls: 'pdf-reader-block-tools', attr: UI });
  for (const page of pages) {
    const title = `查看原 PDF 第 ${page} 页`;
    const source = tools.createEl('button', { type: 'button', text: `原文 p.${page}`, title, attr: { 'aria-label': title } });
    source.addEventListener('click', () => context.options.onSource(page));
  }
  const page = pages[0];
  if (page !== undefined) {
    const title = `复制 PDF 第 ${page} 页的链接`;
    const copy = tools.createEl('button', { type: 'button', text: '复制页链', title, attr: { 'aria-label': title } });
    copy.addEventListener('click', () => context.options.onCopy(page));
  }
}

function appendHtml(parent: HTMLElement, html: string, context: RenderContext, table: boolean, fallbackText: string): void {
  try {
    const fragment = sanitizeHTMLToDom(html);
    // Character references may produce adjacent text nodes; a TeX expression spans them.
    fragment.normalize();
    for (const node of Array.from(fragment.childNodes)) appendSafeNode(parent, node, context, table);
  } catch {
    // The caller's plain text remains preferable to executing parser markup.
    parent.textContent = fallbackText || '内容无法排版，请查看源页。';
  }
}

function appendSafeNode(parent: HTMLElement, node: Node, context: RenderContext, table: boolean): void {
  if (node.nodeType === 3) {
    appendTextWithMath(parent, node.textContent ?? '', context, false);
    return;
  }
  if (node.nodeType !== 1) return;
  const element = node as Element;
  const tag = element.tagName.toUpperCase();
  if (OMIT_TAGS.has(tag)) return;
  const latex = element.getAttribute('data-math') ?? element.getAttribute('data-latex');
  if (tag === 'SPAN' && (latex !== null || element.classList.contains('math-inline') || element.classList.contains('math-display'))) {
    appendMath(parent, stripMathDelimiters(latex ?? element.textContent ?? ''), element.classList.contains('math-display'), context);
    return;
  }
  if (tag === 'IMG') {
    if (table) {
      const reference = element.getAttribute('src') ?? '';
      const url = resolveAsset(reference, context.options);
      if (url) appendImage(parent, url, element.getAttribute('alt') ?? '', context, undefined, reference || undefined);
    }
    return;
  }
  let output: HTMLElement | undefined;
  if (INLINE_TAGS.has(tag) || (table && TABLE_TAGS.has(tag))) {
    output = parent.createEl(tag.toLowerCase() as Tag);
    if (tag === 'TD' || tag === 'TH') {
      for (const attribute of ['colspan', 'rowspan']) {
        const value = Number(element.getAttribute(attribute));
        if (Number.isInteger(value) && value > 0 && value <= 100) output.setAttribute(attribute, String(value));
      }
      const scope = element.getAttribute('scope');
      if (tag === 'TH' && (scope === 'row' || scope === 'col')) output.setAttribute('scope', scope);
    }
  } else if (tag === 'A' && !table) {
    const href = element.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) output = parent.createEl('a', { attr: { href, target: '_blank', rel: 'noopener noreferrer' } });
  }
  for (const child of Array.from(element.childNodes)) appendSafeNode(output ?? parent, child, context, table);
  if (!table && (tag === 'P' || tag === 'DIV') && element.nextSibling) parent.createEl('br');
}

function appendTextWithMath(parent: HTMLElement, text: string, context: RenderContext, inlineMarkup = true): void {
  // MinerU commonly includes <sub>/<sup> in text and captions, without a separate html field.
  if (inlineMarkup && (/<\/?(?:span|sup|sub|em|strong|b|i|u|s|small|br|code|a)\b[^<>]*>/i.test(text) || /&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/i.test(text))) {
    appendHtml(parent, prepareInlineHTML(text), context, false, text);
    return;
  }
  // A lone dollar sign remains normal text; only paired delimiters trigger MathJax.
  const pattern = mathPattern();
  let offset = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > offset) parent.appendText(text.slice(offset, match.index));
    const source = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    appendMath(parent, source, match[1] !== undefined || match[2] !== undefined, context);
    offset = match.index + match[0].length;
  }
  if (offset < text.length) parent.appendText(text.slice(offset));
}

function mathPattern(): RegExp {
  return /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$([^$\n]+?)(?<!\\)\$/g;
}

/** Escape prose and formulas while retaining only inline tags for the sanitizer to inspect. */
function prepareInlineHTML(text: string): string {
  const tokens = new RegExp(`${mathPattern().source}|(<\\/?(?:span|sup|sub|em|strong|b|i|u|s|small|br|code|a)\\b[^<>]*>)`, 'gi');
  let html = '';
  let offset = 0;
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    html += escapeInlineText(text.slice(offset, match.index));
    // Formula text is escaped as a whole, so comparisons and TeX content cannot become HTML.
    html += match[5] !== undefined ? match[0] : escapeInlineText(match[0]);
    offset = match.index + match[0].length;
  }
  return html + escapeInlineText(text.slice(offset));
}

function escapeInlineText(text: string): string {
  return text.replace(/&(?!(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);)/gi, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function appendMath(parent: HTMLElement, source: string, display: boolean, context: RenderContext): boolean {
  try {
    if (!source.trim()) throw new Error('empty equation');
    const key = `${display ? 'display' : 'inline'}:${source}`;
    let templates = mathTemplates.get(context.document);
    let template = templates?.get(key);
    if (!template) {
      const element = renderMath(source, display);
      if (element.querySelector('mjx-merror, .mjx-merror, [data-mjx-error]')) throw new Error('invalid equation');
      // Named equation links need MathJax's label registration on each render.
      const reusable = !/\\(?:label|(?:eq)?ref)\s*\{/.test(source);
      template = { element, flushed: false, scopeIds: reusable && Boolean(element.id || element.querySelector('[id]')) };
      if (reusable) {
        if (!templates) { templates = new Map(); mathTemplates.set(context.document, templates); }
        templates.set(key, template);
        while (templates.size > MATH_TEMPLATE_LIMIT) templates.delete(templates.keys().next().value!);
      }
    } else {
      templates!.delete(key);
      templates!.set(key, template);
    }
    if (!template.flushed) {
      context.mathDocuments.add(template.element.ownerDocument);
      context.pendingMath.add(template);
    }
    const math = cloneMath(template);
    const element = math.ownerDocument === context.document ? math : context.document.adoptNode(math);
    element.classList.add(display ? 'pdf-reader-display-math' : 'pdf-reader-inline-math');
    parent.append(element);
    return true;
  } catch {
    parent.createEl('code', { cls: 'pdf-reader-math-fallback', text: source || '公式未能排版', title: '公式未能排版，请用原文按钮查看源页' });
    return false;
  }
}

function cloneMath(template: MathTemplate): HTMLElement {
  const clone = template.element.cloneNode(true) as HTMLElement;
  if (!template.scopeIds) return clone;
  const elements = [clone, ...Array.from(clone.querySelectorAll('*'))];
  const prefix = `pw-math-${++mathInstance}`;
  const ids = new Map(elements.filter(element => element.id).map((element, index) => [element.id, `${prefix}-${index}`]));
  for (const element of elements) {
    if (element.id) element.id = ids.get(element.id)!;
    for (const attribute of Array.from(element.attributes)) {
      let value = attribute.value;
      if ((attribute.name === 'href' || attribute.name === 'xlink:href') && value.startsWith('#')) value = `#${ids.get(value.slice(1)) ?? value.slice(1)}`;
      else if (attribute.name === 'aria-labelledby' || attribute.name === 'aria-describedby') value = value.split(/\s+/).map(id => ids.get(id) ?? id).join(' ');
      value = value.replace(/url\((['"]?)#([^'")\s]+)\1\)/g, (match: string, quote: string, id: string) => ids.has(id) ? `url(${quote}#${ids.get(id)!}${quote})` : match);
      if (value !== attribute.value) element.setAttributeNS(attribute.namespaceURI, attribute.name, value);
    }
  }
  return clone;
}

async function flushMath(context: RenderContext, onFailure: () => void): Promise<void> {
  if (!context.mathDocuments.size) return;
  try {
    await finishRenderMath();
    // MathJax creates its stylesheet in the document used by renderMath.
    // Obsidian pop-out windows need the same generated rules.
    for (const mathDocument of context.mathDocuments) {
      if (mathDocument === context.document) continue;
      for (const id of ['MJX-CHTML-styles', 'MJX-SVG-styles']) {
        const sourceStyle = mathDocument.getElementById(id);
        if (sourceStyle?.tagName === 'STYLE') adoptMathStyles(context.document, id, sourceStyle.textContent ?? '');
      }
    }
    for (const template of context.pendingMath) template.flushed = true;
  } catch {
    onFailure();
  }
}

const adoptedMathStyles = new WeakMap<Document, Map<string, CSSStyleSheet>>();

function adoptMathStyles(document: Document, id: string, css: string): void {
  const view = document.defaultView;
  if (!view) return;
  let sheets = adoptedMathStyles.get(document);
  if (!sheets) { sheets = new Map(); adoptedMathStyles.set(document, sheets); }
  let sheet = sheets.get(id);
  if (!sheet) {
    sheet = new view.CSSStyleSheet();
    sheets.set(id, sheet);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }
  sheet.replaceSync(css);
}

function resolveAsset(path: string, options: ReaderRenderOptions): string | undefined {
  let value = path.trim();
  if (!value) return undefined;
  try { value = decodeURIComponent(value); } catch { return undefined; }
  if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(value) || value.split(/[\\/]/).includes('..')) return undefined;
  try {
    const resolved = options.assetUrl(value);
    return /^(?:app:|blob:|data:image\/(?:png|jpeg|webp|gif);base64,)/i.test(resolved) ? resolved : undefined;
  } catch { return undefined; }
}

function stripMathDelimiters(text: string): string {
  const source = text.trim();
  for (const [start, end] of [['$$', '$$'], ['\\[', '\\]'], ['\\(', '\\)'], ['$', '$']] as const) {
    if (source.startsWith(start) && source.endsWith(end)) return source.slice(start.length, -end.length).trim();
  }
  return source;
}

function foldKind(block: ReaderBlock): string | undefined {
  if (block.kind === 'heading' && /^(?:\d+[.)]?\s+)?(?:references|bibliography|literature cited|参考文献)\s*[:：]?$/i.test(block.text.trim())) return 'references';
  if (block.kind === 'metadata' || block.kind === 'references') return block.kind;
  if (block.kind === 'header' || block.kind === 'footer') return 'page-furniture';
  if (block.hiddenByDefault && block.kind !== 'footnote') return 'additional';
  return undefined;
}

function foldLabel(kind: string): string {
  if (kind === 'metadata') return '文献信息';
  if (kind === 'references') return '参考文献';
  if (kind === 'page-furniture') return '页眉与页脚';
  return '附加内容';
}

function sourcePages(block: ReaderBlock): number[] {
  return Array.from(new Set(block.sources.map(source => source.page).filter(page => Number.isInteger(page) && page > 0)));
}

function setSources(element: HTMLElement, pages: number[]): void {
  if (pages.length) element.dataset.sourcePages = Array.from(new Set(pages)).join(',');
}

function pagesFromElement(element: HTMLElement): number[] {
  return (element.dataset.sourcePages ?? '').split(',').map(Number).filter(page => Number.isInteger(page) && page > 0);
}

function finiteClamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

/** Yield to the UI every 40 blocks or 12 ms, whichever comes first. */
function batcher(): { due(): boolean; yield(): Promise<void> } {
  let rendered = 0;
  let started = performance.now();
  return {
    due: () => ++rendered % 40 === 0 || performance.now() - started >= 12,
    async yield() {
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      started = performance.now();
    },
  };
}

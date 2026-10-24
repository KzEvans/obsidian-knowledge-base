import type { FileView, TFile } from 'obsidian';
import type { ModuleContext } from '../core/module';
import { ShaCache } from './cache';
import { buildFigureIndex, findFigureRefs, mayReference } from './figure-refs';
import type { FigureRef } from './figure-refs';

/** Where hovering a figure reference previews the figure: reading mode and Markdown notes. */
const SCOPE = '.pdf-reader-content, .markdown-preview-view, .cm-content';
const TEXT_BLOCK = '.pw-layer, p, li, td, th, h1, h2, h3, h4, h5, h6, figcaption, .cm-line';
const NOT_TEXT = '[data-pw-ui], a, code, pre';
const SKIP = `${NOT_TEXT}, [aria-hidden="true"]`;
const SHOW_DELAY_MS = 150;
const RESCAN_MS = 250;
const GAP = 12;
/** CSS Custom Highlight names; styles.css colours them. */
const MARK = 'pw-figure-ref';
const ACTIVE = 'pw-figure-ref-active';

interface Hit { element: HTMLElement; block: HTMLElement; ref: FigureRef; range: Range }
interface Hover extends Hit { timer: number }
interface Watched { view: HTMLElement; file: TFile; observer: MutationObserver; timer: number; ranges: Range[] }

/**
 * Hovering "Figure 4a" / "Fig. 2" / "图 3" in body text shows that figure's MinerU image
 * on the other half of the workspace, like Zotero's figure preview. References whose
 * figure exists are coloured with CSS Custom Highlights. Nothing in the text DOM is
 * changed: references are found from the text itself.
 */
export class FigurePreview {
  /** sha → figure number → image URLs. */
  private readonly figures = new Map<string, Promise<Map<string, string[]>>>();
  private readonly shas: ShaCache;
  private readonly cleanups: Array<() => void> = [];
  private pointer?: { x: number; y: number; document: Document };
  private frame = 0;
  private hover?: Hover;
  private popover?: HTMLElement;
  /** Open PDF and Markdown views, rescanned for references when their DOM changes. */
  private readonly watched = new Map<HTMLElement, Watched>();
  private readonly documents = new Set<Document>();

  constructor(private readonly context: ModuleContext<unknown>) {
    this.shas = new ShaCache(vaultPath => context.store.shaForPath(vaultPath));
  }

  start(): void {
    const { app, plugin, events } = this.context;
    const listen = (document: Document) => {
      plugin.registerDomEvent(document, 'mousemove', event => this.onMove(event));
      plugin.registerDomEvent(document, 'mouseleave', () => this.leave());
      plugin.registerDomEvent(document, 'mousedown', () => this.leave());
      plugin.registerDomEvent(document, 'keydown', () => this.leave());
      plugin.registerDomEvent(document, 'wheel', () => this.leave(), { passive: true });
    };
    listen(activeDocument);
    plugin.registerEvent(app.workspace.on('window-open', win => listen(win.doc)));
    plugin.registerEvent(app.vault.on('modify', file => { if (file.path.toLowerCase().endsWith('.pdf')) this.shas.invalidate(file.path); }));
    this.cleanups.push(events.on('paper:document-updated', ({ sha }) => {
      this.figures.delete(sha);
      for (const entry of this.watched.values()) this.schedule(entry);
    }));
    plugin.registerEvent(app.workspace.on('layout-change', () => this.watchViews()));
    plugin.registerEvent(app.workspace.on('file-open', () => this.watchViews()));
    plugin.registerEvent(app.workspace.on('active-leaf-change', () => this.watchViews()));
    app.workspace.onLayoutReady(() => this.watchViews());
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.leave();
    for (const entry of this.watched.values()) this.unwatch(entry);
    this.watched.clear();
    for (const document of this.documents) {
      registry(document)?.delete(MARK);
      registry(document)?.delete(ACTIVE);
    }
    this.documents.clear();
  }

  private watchViews(): void {
    const seen = new Set<HTMLElement>();
    this.context.app.workspace.iterateAllLeaves(leaf => {
      const file = (leaf.view as Partial<FileView>).file;
      const view = leaf.view.containerEl;
      if (!file || (file.extension !== 'md' && file.extension !== 'pdf') || !view.isConnected) return;
      seen.add(view);
      let entry = this.watched.get(view);
      if (entry?.file === file) return;
      if (entry) this.unwatch(entry);
      const observer = new MutationObserver(() => this.schedule(entry!));
      entry = { view, file, observer, timer: 0, ranges: [] };
      observer.observe(view, { childList: true, subtree: true, characterData: true });
      this.watched.set(view, entry);
      this.schedule(entry);
    });
    for (const [view, entry] of this.watched) if (!seen.has(view)) { this.unwatch(entry); this.watched.delete(view); }
  }

  private unwatch(entry: Watched): void {
    entry.observer.disconnect();
    entry.view.win.clearTimeout(entry.timer);
    this.setMarks(entry, []);
  }

  private schedule(entry: Watched): void {
    entry.view.win.clearTimeout(entry.timer);
    entry.timer = entry.view.win.setTimeout(() => void this.rescan(entry), RESCAN_MS);
  }

  private async rescan(entry: Watched): Promise<void> {
    try {
      const scopes = Array.from(entry.view.querySelectorAll<HTMLElement>(SCOPE));
      const sha = scopes[0] && await this.paperFor(entry.file, scopes[0]);
      const figures = sha ? await this.figuresFor(sha) : undefined;
      if (this.watched.get(entry.view) !== entry) return;
      const ranges = figures?.size ? scopes.flatMap(scope => figureRanges(scope, number => figures.has(number))) : [];
      this.setMarks(entry, ranges);
    } catch (error) {
      this.context.log.warn('图注引用着色失败', error);
    }
  }

  private setMarks(entry: Watched, ranges: Range[]): void {
    const document = entry.view.ownerDocument;
    const marks = highlight(document, MARK);
    if (!marks) return;
    this.documents.add(document);
    for (const range of entry.ranges) marks.delete(range);
    for (const range of ranges) marks.add(range);
    entry.ranges = ranges;
  }

  private onMove(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Node)) return;
    const document = target.ownerDocument ?? activeDocument;
    this.pointer = { x: event.clientX, y: event.clientY, document };
    if (!this.frame) this.frame = (document.defaultView ?? window).requestAnimationFrame(() => { this.frame = 0; this.check(); });
  }

  private check(): void {
    const pointer = this.pointer;
    const hit = pointer && figureRefAt(pointer.document, pointer.x, pointer.y);
    if (!hit) { this.leave(); return; }
    if (this.hover && this.hover.block === hit.block && this.hover.ref.start === hit.ref.start) return;
    this.leave();
    const win = hit.element.win;
    const hover: Hover = { ...hit, timer: win.setTimeout(() => void this.show(hover), SHOW_DELAY_MS) };
    this.hover = hover;
  }

  private leave(): void {
    if (this.hover) this.hover.element.win.clearTimeout(this.hover.timer);
    if (this.popover) highlight(this.popover.ownerDocument, ACTIVE)?.clear();
    this.hover = undefined;
    this.popover?.remove();
    this.popover = undefined;
  }

  private async show(hover: Hover): Promise<void> {
    try {
      const found = this.leafFor(hover.element);
      const sha = found && await this.paperFor(found.file, hover.element);
      const urls = sha ? (await this.figuresFor(sha)).get(hover.ref.number) : undefined;
      if (!found || !urls?.length || this.hover !== hover) return;
      this.popover = renderPopover(found.container, hover.ref.number, urls);
      highlight(hover.element.ownerDocument, ACTIVE)?.add(hover.range);
    } catch (error) {
      this.context.log.warn('图片预览失败', error);
    }
  }

  private leafFor(element: HTMLElement): { file: TFile; container: HTMLElement } | undefined {
    let found: { file: TFile; container: HTMLElement } | undefined;
    this.context.app.workspace.iterateAllLeaves(leaf => {
      const file = (leaf.view as Partial<FileView>).file;
      if (!found && file && leaf.view.containerEl.contains(element)) found = { file, container: leaf.view.containerEl };
    });
    return found;
  }

  /** The paper behind a reading-mode PDF, or the paper a generated note was written from. */
  private async paperFor(file: TFile, element: HTMLElement): Promise<string | undefined> {
    if (file.extension === 'pdf') return element.closest('.pdf-reader-content') ? this.shas.get(file) : undefined;
    if (file.extension !== 'md') return undefined;
    const { metadataCache } = this.context.app;
    const frontmatter = metadataCache.getFileCache(file)?.frontmatter;
    const sha: unknown = frontmatter?.source_sha256;
    if (typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha)) return sha;
    const source: unknown = frontmatter?.source_pdf;
    const link = typeof source === 'string' ? source.replace(/^\[\[|\]\]$/g, '').split(/[|#]/)[0]!.trim() : '';
    const pdf = link ? metadataCache.getFirstLinkpathDest(link, file.path) : null;
    return pdf ? this.shas.get(pdf) : undefined;
  }

  private figuresFor(sha: string): Promise<Map<string, string[]>> {
    let figures = this.figures.get(sha);
    if (!figures) {
      const { store } = this.context;
      figures = store.document(sha).then(document => {
        const urls = new Map<string, string[]>();
        if (!document) return urls;
        for (const [number, references] of buildFigureIndex(document)) {
          const resolved = references.flatMap(reference => {
            const asset = document.assets[reference];
            return asset ? [store.assetUrl(sha, asset.path)] : [];
          });
          if (resolved.length) urls.set(number, resolved);
        }
        return urls;
      });
      // A failed read is retried on the next hover.
      figures.catch(() => this.figures.delete(sha));
      this.figures.set(sha, figures);
    }
    return figures;
  }
}

/** The figure reference under the pointer, if the pointer is on its text. */
export function figureRefAt(document: Document, x: number, y: number): Hit | undefined {
  const position = document.caretPositionFromPoint(x, y);
  const node = position?.offsetNode;
  if (node?.nodeType !== Node.TEXT_NODE) return undefined;
  const element = node.parentElement;
  if (!element?.closest(SCOPE) || element.closest(SKIP)) return undefined;
  const block = element.closest<HTMLElement>(TEXT_BLOCK) ?? element.closest<HTMLElement>(SCOPE)!;
  const nodes = textNodes(block);
  let text = '';
  let offset = -1;
  for (const each of nodes) {
    if (each === node) offset = text.length + position!.offset;
    text += each.data;
  }
  if (offset < 0 || !mayReference(text)) return undefined;
  const caption = Boolean(element.closest('figcaption'));
  const ref = findFigureRefs(text, caption).find(each => offset >= each.start && offset <= each.end);
  if (!ref) return undefined;
  const range = rangeFor(document, nodes, ref.start, ref.end);
  const inside = Array.from(range.getClientRects()).some(rect => x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1);
  return inside ? { element, block, ref, range } : undefined;
}

/** Ranges of the references in `scope` whose figure `exists`; both language layers are scanned. */
export function figureRanges(scope: HTMLElement, exists: (number: string) => boolean): Range[] {
  const ranges: Range[] = [];
  for (const block of Array.from(scope.querySelectorAll<HTMLElement>(TEXT_BLOCK))) {
    // The innermost text block owns its text; outer ones (a <p> around .pw-layer) are skipped.
    if (block.querySelector(TEXT_BLOCK) || !mayReference(block.textContent)) continue;
    const nodes = textNodes(block);
    const text = nodes.map(node => node.data).join('');
    for (const ref of findFigureRefs(text, Boolean(block.closest('figcaption')))) {
      if (!exists(ref.number)) continue;
      const range = rangeFor(scope.ownerDocument, nodes, ref.start, ref.end);
      if (!range.startContainer.parentElement?.closest(NOT_TEXT)) ranges.push(range);
    }
  }
  return ranges;
}

function registry(document: Document): HighlightRegistry | undefined {
  return document.defaultView?.CSS?.highlights;
}

/** The document's named highlight, created on first use; undefined without the Highlight API. */
function highlight(document: Document, name: string): Highlight | undefined {
  const win = document.defaultView;
  const highlights = registry(document);
  if (!win || !highlights) return undefined;
  let found = highlights.get(name);
  if (!found) { found = new win.Highlight(); highlights.set(name, found); }
  return found;
}

function textNodes(block: HTMLElement): Text[] {
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

function rangeFor(document: Document, nodes: readonly Text[], start: number, end: number): Range {
  const range = document.createRange();
  let position = 0;
  for (const node of nodes) {
    const next = position + node.data.length;
    if (start >= position && start <= next) range.setStart(node, start - position);
    if (end >= position && end <= next) { range.setEnd(node, end - position); break; }
    position = next;
  }
  return range;
}

/** Fills the half of the workspace the hovered view is not on. */
function renderPopover(viewEl: HTMLElement, number: string, urls: readonly string[]): HTMLElement {
  const document = viewEl.ownerDocument;
  const area = (viewEl.closest<HTMLElement>('.mod-root') ?? document.body).getBoundingClientRect();
  const view = viewEl.getBoundingClientRect();
  const half = area.width / 2;
  const onRight = view.left + view.width / 2 > area.left + half;
  const [kind, digits] = number.split(' ');
  const label = kind === 'scheme' ? `方案 ${digits}` : kind === 'table' ? `表 ${digits}` : `图 ${number}`;
  const popover = document.body.createDiv({ cls: 'pw-figure-preview', attr: { role: 'tooltip', 'aria-label': label } });
  popover.setCssStyles({
    left: `${(onRight ? area.left : area.left + half) + GAP}px`,
    top: `${area.top + GAP}px`,
    width: `${half - GAP * 2}px`,
    height: `${area.height - GAP * 2}px`,
  });
  for (const url of urls) popover.createEl('img', { attr: { src: url, alt: label } });
  return popover;
}

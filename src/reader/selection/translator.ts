import { Notice, setIcon } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type { ModuleContext } from '../../core/module';
import { leafId } from '../../core/pdf-toolbar';
import { SELECTION_MODEL, termsKey } from '../../core/qwen-mt';
import { errorMessage } from '../../core/secrets';
import { chooseRangeRect, convertRectToDocument, isInHiddenLayer, isNode, isNodeInsideView, normalizePdfSelection, readerSelectionText } from './dom';
import type { PointerLocation } from './dom';
import { placePopup } from './geometry';
import type { SelectionSettings } from './settings';

const PDF_VIEW_TYPE = 'pdf';
const MAX_CACHE_ENTRIES = 100;
export const BUTTON_ID = 'selection-translate';
/** DOM contract with the reading mode (architecture §6.3). */
const READER_ROOT = '.pdf-reader-content[data-pdf-reader-active="true"]';
const NATIVE_ROOTS = ['.pdf-viewer-container', '.pdf-content-container', '.pdf-container', '.view-content'];

interface SelectionSnapshot {
  document: Document;
  range: Range;
  text: string;
  pointer?: PointerLocation;
}

interface LeafState {
  leaf: WorkspaceLeaf;
  filePath?: string;
  enabled: boolean;
  /** Last `reader:mode-change` for this leaf. */
  reader?: { active: boolean; language: 'en' | 'zh' };
  popup?: HTMLElement;
  snapshot?: SelectionSnapshot;
  abortController?: AbortController;
  requestId: number;
}

/** Per-tab selection translation on native PDF views and the reading mode's English layer. */
export class SelectionTranslator {
  private readonly states = new Map<WorkspaceLeaf, LeafState>();
  private readonly observedDocuments = new WeakSet<Document>();
  private readonly observedFrames = new WeakSet<HTMLIFrameElement>();
  private readonly selectingDocuments = new WeakSet<Document>();
  private readonly selectionTimers = new Map<Document, number>();
  private readonly cache = new Map<string, string>();
  private activePdfLeaf: WorkspaceLeaf | undefined;
  private refreshTimer = 0;

  constructor(private readonly context: ModuleContext<SelectionSettings>) {}

  start(): void {
    const { app, plugin, events, services } = this.context;
    plugin.addCommand({
      id: 'toggle-selection-translation',
      name: '切换当前 PDF 的划线翻译',
      checkCallback: checking => {
        const leaf = this.activePdfLeaf;
        if (!leaf) return false;
        if (!checking) this.toggle(leaf);
        return true;
      },
    });
    plugin.register(services.pdfToolbar.register({
      id: BUTTON_ID,
      order: 20,
      icon: 'languages',
      label: '划线翻译',
      onClick: leaf => this.toggle(leaf),
      update: (leaf, button) => this.updateButton(this.stateFor(leaf), button),
    }));
    plugin.register(events.on('reader:mode-change', payload => this.onReaderModeChange(payload)));

    plugin.registerEvent(app.workspace.on('layout-change', () => this.queueRefresh()));
    plugin.registerEvent(app.workspace.on('file-open', () => this.queueRefresh()));
    plugin.registerEvent(app.workspace.on('active-leaf-change', leaf => {
      this.activePdfLeaf = leaf?.view.getViewType() === PDF_VIEW_TYPE ? leaf : undefined;
      this.queueRefresh();
    }));
    plugin.registerEvent(app.workspace.on('resize', () => this.repositionAllPopups()));
    plugin.registerEvent(app.workspace.on('window-open', (_workspaceWindow, openedWindow) => {
      this.observeDocument(openedWindow.document);
      this.queueRefresh();
    }));

    this.observeDocument(activeDocument);
    app.workspace.onLayoutReady(() => this.refresh());
  }

  dispose(): void {
    window.clearTimeout(this.refreshTimer);
    for (const timer of this.selectionTimers.values()) window.clearTimeout(timer);
    this.selectionTimers.clear();
    for (const state of this.states.values()) this.closePopup(state);
    this.states.clear();
    this.cache.clear();
  }

  /** Track open PDF leaves: drop closed ones, clear a leaf whose file changed, watch new frames. */
  refresh(): void {
    const current = new Set<WorkspaceLeaf>();
    this.context.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view.getViewType() !== PDF_VIEW_TYPE || !leaf.view.containerEl.isConnected) return;
      current.add(leaf);
      const state = this.stateFor(leaf);
      const filePath = pdfFilePath(leaf);
      if (state.filePath !== filePath) {
        this.resetLeafSelection(state);
        state.filePath = filePath;
      }
      this.observePdfFrames(leaf);
    });
    for (const [leaf, state] of this.states) {
      if (current.has(leaf)) continue;
      this.closePopup(state);
      this.states.delete(leaf);
    }
  }

  toggle(leaf: WorkspaceLeaf): void {
    const state = this.stateFor(leaf);
    if (!state.enabled && !this.context.secrets.get('dashscope')) {
      new Notice('请先在“服务与密钥”设置中保存阿里云百炼 API Key。');
      return;
    }
    state.enabled = !state.enabled;
    if (!state.enabled) this.closePopup(state);
    this.context.services.pdfToolbar.refresh();
    new Notice(state.enabled ? '当前 PDF 已开启划线翻译' : '当前 PDF 已关闭划线翻译', 1800);
  }

  isEnabled(leaf: WorkspaceLeaf): boolean {
    return this.states.get(leaf)?.enabled ?? false;
  }

  observeDocument(document: Document): void {
    if (this.observedDocuments.has(document)) return;
    this.observedDocuments.add(document);
    const { plugin } = this.context;

    plugin.registerDomEvent(document, 'mouseup', event => {
      this.selectingDocuments.delete(document);
      if (this.isPopupTarget(event.target)) return;
      this.scheduleSelection(document, 20, { x: event.clientX, y: event.clientY });
    });
    plugin.registerDomEvent(document, 'selectionchange', () => {
      if (this.selectingDocuments.has(document)) return;
      this.scheduleSelection(document, 260);
    });
    plugin.registerDomEvent(document, 'keydown', event => {
      if (event.key === 'Escape') this.closeDocumentPopups(document);
      if (event.shiftKey && event.key.startsWith('Arrow')) this.scheduleSelection(document, 80);
    });
    plugin.registerDomEvent(document, 'pointerdown', event => {
      this.selectingDocuments.add(document);
      if (!this.isPopupTarget(event.target)) this.closeDocumentPopups(document);
    }, { capture: true });
    plugin.registerDomEvent(document, 'pointercancel', () => this.selectingDocuments.delete(document));
    plugin.registerDomEvent(document, 'scroll', () => {
      document.defaultView?.requestAnimationFrame(() => this.repositionAllPopups());
    }, { capture: true, passive: true });
  }

  /** Read the document's current selection and translate it if it belongs to an enabled PDF leaf. */
  handleSelection(document: Document, pointer?: PointerLocation): void {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    if (this.isNodeInAnyPopup(range.commonAncestorContainer)) return;

    const found = this.locate(range);
    if (!found) return;
    const { state, inReader } = found;

    const text = normalizePdfSelection(inReader ? readerSelectionText(range) : selection.toString());
    if (!text) return;

    const limit = this.context.settings.maxSelectionCharacters;
    if (text.length > limit) {
      this.closeOtherPopups(state);
      this.showPopup(state, { document, range: range.cloneRange(), text, pointer }, pointer);
      this.renderError(state, `已选择 ${text.length.toLocaleString()} 个字符，超过当前上限 ${limit.toLocaleString()}。请缩小选区或在设置中提高上限。`, false);
      return;
    }

    if (state.popup && state.snapshot?.text === text) return;

    this.closeOtherPopups(state);
    this.showPopup(state, { document, range: range.cloneRange(), text, pointer }, pointer);
    void this.translateSnapshot(state);
  }

  // ---- leaf lookup ----

  private stateFor(leaf: WorkspaceLeaf): LeafState {
    let state = this.states.get(leaf);
    if (!state) {
      state = { leaf, filePath: pdfFilePath(leaf), enabled: false, requestId: 0 };
      this.states.set(leaf, state);
    }
    return state;
  }

  /** The enabled leaf this range belongs to, or nothing when it is in the reading mode's Chinese layer. */
  private locate(range: Range): { state: LeafState; inReader: boolean } | undefined {
    const node = range.commonAncestorContainer;
    for (const state of this.states.values()) {
      if (!state.enabled) continue;
      const container = state.leaf.view.containerEl;
      const reader = container.querySelector<HTMLElement>(READER_ROOT);
      const root = reader ?? nativeRoot(container);
      if (!isNodeInsideView(node, root)) continue;
      if (!reader) return { state, inReader: false };
      const chinese = reader.dataset.lang === 'zh' || (state.reader?.active === true && state.reader.language === 'zh');
      if (chinese) return undefined;
      if ([node, range.startContainer, range.endContainer].some(candidate => isInHiddenLayer(candidate, reader))) return undefined;
      return { state, inReader: true };
    }
    return undefined;
  }

  private onReaderModeChange(payload: { leafId: string; active: boolean; language: 'en' | 'zh' }): void {
    for (const state of this.states.values()) {
      if (leafId(state.leaf) !== payload.leafId) continue;
      state.reader = { active: payload.active, language: payload.language };
      this.resetLeafSelection(state);
    }
  }

  private observePdfFrames(leaf: WorkspaceLeaf): void {
    this.observeDocument(leaf.view.containerEl.ownerDocument);
    for (const frame of Array.from(leaf.view.containerEl.querySelectorAll('iframe'))) {
      if (!this.observedFrames.has(frame)) {
        this.observedFrames.add(frame);
        this.context.plugin.registerDomEvent(frame, 'load', () => this.observeFrame(frame));
      }
      this.observeFrame(frame);
    }
  }

  private observeFrame(frame: HTMLIFrameElement): void {
    try {
      if (frame.contentDocument) this.observeDocument(frame.contentDocument);
    } catch {
      // Cross-origin frames cannot be inspected; Obsidian's PDF frame is same-origin.
    }
  }

  // ---- translation ----

  private async translateSnapshot(state: LeafState): Promise<void> {
    const snapshot = state.snapshot;
    if (!snapshot || !state.popup) return;

    const requestId = ++state.requestId;
    this.renderLoading(state);
    const terms = this.context.core.glossary;
    const cacheKey = `${SELECTION_MODEL}\n${termsKey(snapshot.text, terms)}\n${snapshot.text}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      this.renderTranslation(state, cached);
      return;
    }

    state.abortController?.abort();
    const abortController = new AbortController();
    state.abortController = abortController;
    try {
      // Only the selected text leaves the machine: no file name, path or surrounding content.
      const translation = await this.context.qwenMt.translate({
        text: snapshot.text,
        model: SELECTION_MODEL,
        terms,
        timeoutMs: this.context.settings.timeoutSeconds * 1_000,
        signal: abortController.signal,
      });
      if (state.requestId !== requestId || !state.popup) return;
      this.cacheTranslation(cacheKey, translation);
      this.renderTranslation(state, translation);
    } catch (error) {
      if (state.requestId !== requestId || !state.popup) return;
      this.renderError(state, errorMessage(error) || '翻译失败，请重试。', true);
    } finally {
      if (state.abortController === abortController) state.abortController = undefined;
    }
  }

  private cacheTranslation(key: string, value: string): void {
    this.cache.set(key, value);
    if (this.cache.size <= MAX_CACHE_ENTRIES) return;
    const oldest = this.cache.keys().next().value;
    if (oldest !== undefined) this.cache.delete(oldest);
  }

  // ---- popup ----

  private showPopup(state: LeafState, snapshot: SelectionSnapshot, pointer?: PointerLocation): void {
    this.closePopup(state);
    state.snapshot = snapshot;

    const document = state.leaf.view.containerEl.ownerDocument;
    const popup = document.body.createEl('section', { cls: 'pw-selection-popup', attr: { role: 'dialog', 'aria-label': 'PDF 选区翻译' } });
    popup.addEventListener('pointerdown', event => event.stopPropagation());

    const header = popup.createDiv({ cls: 'pw-selection-popup-header' });
    const title = header.createDiv({ cls: 'pw-selection-popup-title' });
    setIcon(title.createSpan({ cls: 'pw-selection-popup-title-icon' }), 'languages');
    title.createSpan({ text: '翻译 · 中文' });

    const actions = header.createDiv({ cls: 'pw-selection-popup-actions' });
    const copyButton = iconButton(actions, 'copy', '复制翻译', 'pw-selection-copy');
    copyButton.addEventListener('click', () => void this.copyTranslation(state));
    const closeButton = iconButton(actions, 'x', '关闭翻译', 'pw-selection-close');
    closeButton.addEventListener('click', () => this.closePopup(state));

    popup.createDiv({ cls: 'pw-selection-popup-body', attr: { 'aria-live': 'polite' } });
    state.popup = popup;

    this.positionPopup(state, pointer);
  }

  private renderLoading(state: LeafState): void {
    const body = popupBody(state);
    if (!body) return;
    body.replaceChildren();
    body.classList.add('is-loading');
    const loading = body.createDiv({ cls: 'pw-selection-loading' });
    loading.createSpan({ cls: 'pw-selection-spinner' });
    loading.createSpan({ text: `Qwen-MT · ${SELECTION_MODEL} 正在翻译…` });
    this.schedulePopupPosition(state);
  }

  private renderTranslation(state: LeafState, translation: string): void {
    const body = popupBody(state);
    if (!body) return;
    body.replaceChildren();
    body.classList.remove('is-loading', 'is-error');
    body.createDiv({ cls: 'pw-selection-result', text: translation });
    state.popup?.setAttribute('data-translation', translation);
    this.schedulePopupPosition(state);
  }

  private renderError(state: LeafState, message: string, canRetry: boolean): void {
    const body = popupBody(state);
    if (!body) return;
    body.replaceChildren();
    body.classList.remove('is-loading');
    body.classList.add('is-error');
    const row = body.createDiv({ cls: 'pw-selection-error' });
    setIcon(row.createSpan({ cls: 'pw-selection-error-icon' }), 'circle-alert');
    row.createDiv({ text: message });
    if (canRetry) {
      const retry = body.createEl('button', { cls: 'mod-cta pw-selection-retry', text: '重试', attr: { type: 'button' } });
      retry.addEventListener('click', () => void this.translateSnapshot(state));
    }
    this.schedulePopupPosition(state);
  }

  private async copyTranslation(state: LeafState): Promise<void> {
    const translation = state.popup?.getAttribute('data-translation');
    if (!translation) return;
    try {
      await navigator.clipboard.writeText(translation);
      new Notice('翻译已复制', 1500);
    } catch {
      new Notice('复制失败，请手动选择翻译文本。', 2200);
    }
  }

  private closePopup(state: LeafState): void {
    state.abortController?.abort();
    state.abortController = undefined;
    state.requestId += 1;
    state.popup?.remove();
    state.popup = undefined;
    state.snapshot = undefined;
  }

  /** Mode switch or a new file in the same tab: drop popup, request, pending timers and the selection. */
  private resetLeafSelection(state: LeafState): void {
    const documents = new Set<Document>([state.leaf.view.containerEl.ownerDocument]);
    if (state.snapshot) documents.add(state.snapshot.document);
    this.closePopup(state);

    for (const document of documents) {
      const timer = this.selectionTimers.get(document);
      if (timer !== undefined) window.clearTimeout(timer);
      this.selectionTimers.delete(document);
      this.selectingDocuments.delete(document);

      const selection = document.getSelection();
      if (selection && selection.rangeCount > 0 && isNodeInsideView(selection.getRangeAt(0).commonAncestorContainer, state.leaf.view.containerEl)) {
        selection.removeAllRanges();
      }
    }
  }

  private closeOtherPopups(except: LeafState): void {
    for (const state of this.states.values()) if (state !== except) this.closePopup(state);
  }

  private closeDocumentPopups(document: Document): void {
    for (const state of this.states.values()) {
      if (state.popup?.ownerDocument === document || state.snapshot?.document === document) this.closePopup(state);
    }
  }

  private scheduleSelection(document: Document, delay: number, pointer?: PointerLocation): void {
    const previous = this.selectionTimers.get(document);
    if (previous !== undefined) window.clearTimeout(previous);
    this.selectionTimers.set(document, window.setTimeout(() => {
      this.selectionTimers.delete(document);
      this.handleSelection(document, pointer);
    }, delay));
  }

  private queueRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.refresh(), 50);
  }

  private schedulePopupPosition(state: LeafState): void {
    state.popup?.ownerDocument.defaultView?.requestAnimationFrame(() => this.positionPopup(state));
  }

  private repositionAllPopups(): void {
    for (const state of this.states.values()) if (state.popup) this.positionPopup(state);
  }

  private positionPopup(state: LeafState, pointer?: PointerLocation): void {
    const { popup, snapshot } = state;
    if (!popup || !snapshot || !popup.isConnected) return;

    const container = state.leaf.view.containerEl;
    const boundary = (container.querySelector<HTMLElement>('.view-content') ?? container).getBoundingClientRect();
    const sourceAnchor = chooseRangeRect(snapshot.range, pointer ?? snapshot.pointer);
    if (!sourceAnchor) return;
    const anchor = convertRectToDocument(sourceAnchor, snapshot.document, popup.ownerDocument);
    if (!anchor) return;

    popup.style.setProperty('width', `${Math.min(380, Math.max(140, boundary.width - 20))}px`);
    popup.style.setProperty('max-height', `${Math.max(80, boundary.height - 20)}px`);
    const measured = popup.getBoundingClientRect();
    const placement = placePopup(anchor, boundary, { width: measured.width, height: measured.height });
    popup.style.setProperty('left', `${Math.round(placement.left)}px`);
    popup.style.setProperty('top', `${Math.round(placement.top)}px`);
    popup.dataset.side = placement.side;
  }

  private updateButton(state: LeafState, button: HTMLElement): void {
    const label = state.enabled ? '划线翻译：已开启（点击关闭）' : '划线翻译：已关闭（点击开启）';
    button.classList.add('pw-selection-toggle');
    button.classList.toggle('is-enabled', state.enabled);
    button.setAttribute('aria-pressed', String(state.enabled));
    button.setAttribute('aria-label', label);
    button.setAttribute('data-tooltip-position', 'bottom');
  }

  private isNodeInAnyPopup(node: Node): boolean {
    for (const state of this.states.values()) if (state.popup?.contains(node)) return true;
    return false;
  }

  private isPopupTarget(target: EventTarget | null): boolean {
    return isNode(target) && this.isNodeInAnyPopup(target);
  }
}

function nativeRoot(container: HTMLElement): HTMLElement {
  for (const selector of NATIVE_ROOTS) {
    const found = container.querySelector<HTMLElement>(selector);
    if (found) return found;
  }
  return container;
}

function pdfFilePath(leaf: WorkspaceLeaf): string | undefined {
  const file = leaf.view.getState().file;
  return typeof file === 'string' ? file : undefined;
}

function popupBody(state: LeafState): HTMLElement | null {
  return state.popup?.querySelector<HTMLElement>('.pw-selection-popup-body') ?? null;
}

function iconButton(parent: HTMLElement, icon: string, label: string, cls: string): HTMLElement {
  const button = parent.createEl('button', { cls: `clickable-icon ${cls}`, attr: { type: 'button', 'aria-label': label } });
  setIcon(button, icon);
  return button;
}

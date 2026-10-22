import { Notice } from 'obsidian';
import type { FileView, TFile, View, WorkspaceLeaf } from 'obsidian';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256Bytes } from '../core/hash';
import type { ModuleContext } from '../core/module';
import { leafId } from '../core/pdf-toolbar';
import type { Manifest } from '../core/types';
import { PaperCache, ShaCache } from './cache';
import type { LoadedPaper } from './cache';
import { prepareNearbyImages } from './image-decode';
import { ConfirmModal, FigureModal, MessageModal } from './modals';
import {
  blockSearchText, createSourcePageTracker, getVisibleSourcePage, measureZhScale, needsCleanCopy, readableText,
  renderReader, scrollToSourcePage, setLanguage, setTypography, setZhScale, updateTranslations,
} from './render';
import type { Language } from './render';
import { observeScrollPerformance } from './scroll-performance';
import type { ScrollPerformanceReport } from './scroll-performance';
import type { ReaderSettings } from './settings';
import { FONT_SIZE, clampNumber } from './settings';
import { describeStatus, languageButton, renderStatus, stageLabel } from './status';
import type { Progress, StatusAction } from './status';

interface NativeElement { element: HTMLElement; inert: boolean; ariaHidden: string | null }

interface LeafState {
  leaf: WorkspaceLeaf; view: View; file: TFile; filePath: string; revision: number;
  content: HTMLElement; document: Document; desired: boolean; generation: number; page: number;
  language: Language;
  sha?: string; paper?: LoadedPaper; manifest?: Manifest; conflicts: string[];
  /** Page to restore when the reader is rebuilt in place (new document, changed file). */
  reopenPage?: number;
  linkedPage?: number;
  mounting?: number;
  pendingTranslations?: boolean;
  askedConsent?: boolean;
  shell?: HTMLElement; root?: HTMLElement; waiting?: HTMLElement; pageLabel?: HTMLElement; pageInput?: HTMLInputElement;
  search?: HTMLInputElement; languageButton?: HTMLButtonElement; statusLabel?: HTMLElement;
  nativeElements: NativeElement[];
  originalEphemeral: View['setEphemeralState']; wrappedEphemeral: View['setEphemeralState'];
  saveTimer?: number; translationTimer?: number;
  pageTracker?: ReturnType<typeof createSourcePageTracker>;
  stopScrollProfile?: () => void;
  stopImageDecoding?: () => void;
}

/** Open-to-first-screen timings, recorded only with scroll diagnostics on. */
interface OpenTiming { cached: boolean; blocks: number; loadMs: number; renderMs: number; firstScreenMs: number }

const TRANSLATION_REFRESH_MS = 3000;

export class ReaderController {
  private readonly states = new Map<WorkspaceLeaf, LeafState>();
  private readonly cache: PaperCache;
  private readonly shas: ShaCache;
  private readonly parseProgress = new Map<string, Progress>();
  private readonly translationProgress = new Map<string, Progress>();
  private readonly cleanups: Array<() => void> = [];
  private refreshTimer = 0;
  private disposed = false;

  constructor(private readonly context: ModuleContext<ReaderSettings>) {
    this.cache = new PaperCache(context.store);
    this.shas = new ShaCache(vaultPath => context.store.shaForPath(vaultPath), async vaultPath => sha256Bytes(await context.app.vault.adapter.readBinary(vaultPath)));
  }

  get settings(): ReaderSettings { return this.context.settings; }

  start(): void {
    const { app, plugin, events, services } = this.context;
    this.cleanups.push(services.pdfToolbar.register({
      id: 'reader-mode', order: 10, icon: 'book-open', label: '开启单栏阅读模式',
      onClick: leaf => {
        this.refresh();
        const state = this.states.get(leaf);
        if (state) void this.toggle(state);
      },
      update: (leaf, element) => {
        const active = this.states.get(leaf)?.desired === true;
        const label = active ? '单栏阅读模式：已开启（点击返回原 PDF）' : '开启单栏阅读模式';
        element.toggleClass('is-enabled', active);
        element.setAttribute('aria-pressed', String(active));
        element.setAttribute('aria-label', label);
      },
    }));
    plugin.addCommand({
      id: 'reader-toggle', name: '切换当前 PDF 的单栏阅读模式',
      checkCallback: checking => {
        const state = this.activeState();
        if (!state) return false;
        if (!checking) void this.toggle(state);
        return true;
      },
    });
    plugin.addCommand({
      id: 'reader-toggle-language', name: '阅读模式：切换中文 / 英文',
      checkCallback: checking => {
        const state = this.activeState();
        if (!state?.root || !this.translationsAvailable(state)) return false;
        if (!checking) this.switchLanguage(state, state.language === 'zh' ? 'en' : 'zh');
        return true;
      },
    });
    plugin.registerEvent(app.workspace.on('layout-change', () => this.queueRefresh()));
    plugin.registerEvent(app.workspace.on('active-leaf-change', () => this.queueRefresh()));
    plugin.registerEvent(app.workspace.on('file-open', () => this.queueRefresh()));
    plugin.registerEvent(app.workspace.on('window-open', () => this.queueRefresh()));
    plugin.registerEvent(app.vault.on('modify', file => {
      if (file.path.toLowerCase().endsWith('.pdf')) this.shas.invalidate(file.path);
      for (const state of this.states.values()) if (state.file === file) this.reopen(state);
    }));
    plugin.registerEvent(app.vault.on('rename', file => {
      for (const state of this.states.values()) if (state.file === file) state.filePath = file.path;
      this.queueRefresh();
    }));

    const forPaper = (sha: string, handle: (state: LeafState) => void) => {
      for (const state of this.states.values()) if (state.desired && state.sha === sha) handle(state);
    };
    this.cleanups.push(
      events.on('paper:stage-changed', ({ sha }) => forPaper(sha, state => void this.refreshStatus(state))),
      events.on('paper:parse-progress', ({ sha, done, total }) => {
        this.parseProgress.set(sha, { done, total });
        forPaper(sha, state => this.showStatus(state));
      }),
      events.on('paper:translation-progress', ({ sha, done, total, failed }) => {
        this.translationProgress.set(sha, { done, total, failed });
        forPaper(sha, state => { this.updateLanguageButton(state); this.scheduleTranslationRefresh(state); });
      }),
      events.on('paper:document-updated', ({ sha }) => {
        this.cache.invalidate(sha);
        forPaper(sha, state => this.reopen(state));
      }),
      events.on('paper:conflict', ({ sha, files }) => forPaper(sha, state => {
        state.conflicts = files;
        new Notice(`《${state.file.basename}》的解析存储出现 iCloud 冲突副本：${files.join('、')}。请在文献库面板处理。`, 10_000);
        this.updateToolbarStatus(state);
      })),
    );
    app.workspace.onLayoutReady(() => this.refresh());
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.refreshTimer);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const state of this.states.values()) this.removeState(state);
    this.states.clear();
    this.cache.stop();
  }

  refreshTypography(): void {
    for (const state of this.states.values()) if (state.root) setTypography(state.root, this.settings.fontSize, this.settings.lineHeight);
  }

  private activeState(): LeafState | undefined {
    const leaf = this.context.app.workspace.getMostRecentLeaf();
    if (!leaf || leaf.view.getViewType() !== 'pdf') return undefined;
    this.refresh();
    return this.states.get(leaf);
  }

  private queueRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.refresh(), 60);
  }

  private refresh(): void {
    if (this.disposed) return;
    const leaves = new Set<WorkspaceLeaf>();
    this.context.app.workspace.iterateAllLeaves(leaf => {
      const view = leaf.view;
      if (view.getViewType() !== 'pdf' || !view.containerEl.isConnected) return;
      const file = (view as FileView).file;
      if (!file) { this.queueRefresh(); return; }
      leaves.add(leaf);
      let state = this.states.get(leaf);
      if (state && (state.view !== view || state.filePath !== file.path || state.document !== view.containerEl.ownerDocument || !state.content.isConnected || state.content !== view.containerEl.querySelector('.view-content'))) {
        this.removeState(state);
        this.states.delete(leaf);
        state = undefined;
      }
      if (!state) {
        state = this.createState(leaf, file);
        if (state) this.states.set(leaf, state);
      }
      if (state && state.file !== file) {
        state.file = file;
        if (state.revision !== file.stat.mtime) this.reopen(state);
      }
    });
    for (const [leaf, state] of this.states) if (!leaves.has(leaf)) { this.removeState(state); this.states.delete(leaf); }
  }

  private createState(leaf: WorkspaceLeaf, file: TFile): LeafState | undefined {
    const view = leaf.view;
    const content = view.containerEl.querySelector<HTMLElement>('.view-content');
    if (!content) { this.queueRefresh(); return; }
    // Restored as-is on removal and only ever invoked with .call(view).
    // eslint-disable-next-line @typescript-eslint/unbound-method -- see above
    const originalEphemeral = view.setEphemeralState;
    const state: LeafState = {
      leaf, view, file, filePath: file.path, revision: file.stat.mtime, content, document: view.containerEl.ownerDocument,
      desired: false, generation: 0, page: 0, language: 'en', conflicts: [], nativeElements: [], originalEphemeral, wrappedEphemeral: originalEphemeral,
    };
    state.wrappedEphemeral = (value: unknown) => {
      const incoming = value as { subpath?: unknown } | undefined;
      const subpath = typeof incoming?.subpath === 'string' ? incoming.subpath : '';
      const page = Number(/(?:^#?|&)page=(\d+)/.exec(subpath)?.[1]);
      // Selection and annotation links highlight text only the native view can show.
      const precise = /(?:^#?|&)(?:selection|annotation|offset)=/.test(subpath);
      if (precise && state.desired) this.exit(state, false);
      originalEphemeral.call(view, value);
      if (page > 0 && Number.isFinite(page)) {
        state.page = page;
        if (state.desired && state.root) this.navigateReader(state, page);
        else state.linkedPage = page;
      }
    };
    view.setEphemeralState = state.wrappedEphemeral;
    return state;
  }

  private removeState(state: LeafState): void {
    state.document.defaultView?.clearTimeout(state.saveTimer);
    state.document.defaultView?.clearTimeout(state.translationTimer);
    this.exit(state, false);
    if (state.view.setEphemeralState === state.wrappedEphemeral) state.view.setEphemeralState = state.originalEphemeral;
  }

  private async toggle(state: LeafState): Promise<void> {
    if (state.desired) { this.exit(state); return; }
    const started = performance.now();
    state.desired = true;
    state.generation++;
    state.askedConsent = false;
    this.context.services.pdfToolbar.refresh();
    state.page = state.reopenPage ?? state.linkedPage ?? 0;
    state.linkedPage = undefined;
    state.reopenPage = undefined;
    const generation = state.generation;
    this.showWaiting(state, '正在准备单栏阅读…');
    try {
      await this.load(state, generation, started);
    } catch (error) {
      if (!this.isCurrent(state, generation)) return;
      this.context.log.warn('阅读模式打开失败', error);
      this.exit(state, false);
      const banner = state.content.createDiv({ cls: 'pdf-reader-processing is-error', attr: { role: 'alert', 'data-pw-ui': '' } });
      state.waiting = banner;
      banner.createSpan({ text: error instanceof Error ? error.message : '阅读模式打开失败，请重试。' });
      banner.createEl('button', { text: '重试' }).addEventListener('click', () => { banner.remove(); state.waiting = undefined; void this.toggle(state); });
      banner.createEl('button', { text: '关闭' }).addEventListener('click', () => { banner.remove(); state.waiting = undefined; });
    }
  }

  /** Find the paper, then either show it or show where the pipeline is. */
  private async load(state: LeafState, generation: number, started: number): Promise<void> {
    const sha = await this.shas.get(state.file);
    if (!this.isCurrent(state, generation)) return;
    if (!sha) throw new Error('无法读取这篇 PDF。');
    state.sha = sha;
    if (!state.page) state.page = this.settings.positions[sha] ?? currentNativePage(state) ?? 1;
    const cached = this.cache.has(sha);
    const [manifest, conflicts, paper] = await Promise.all([this.manifest(sha), this.context.store.conflicts(sha), this.cache.get(sha)]);
    if (!this.isCurrent(state, generation)) return;
    state.manifest = manifest;
    state.conflicts = conflicts;
    if (!paper) {
      this.showStatus(state);
      if (!manifest && this.context.services.pipeline && !state.askedConsent) {
        state.askedConsent = true;
        this.askConsent(state);
      }
      return;
    }
    state.paper = paper;
    await this.mount(state, generation, { started, loaded: performance.now(), cached });
  }

  private manifest(sha: string): Promise<Manifest | undefined> {
    return this.context.services.pipeline?.status(sha) ?? this.context.store.manifest(sha);
  }

  /** A stage change: re-read the manifest; a newly available document opens the reader. */
  private async refreshStatus(state: LeafState): Promise<void> {
    const generation = state.generation;
    const sha = state.sha;
    if (!sha) return;
    try {
      if (!state.root) {
        // Supersede any load still in flight, so only one reader is mounted.
        if (!state.desired) return;
        const next = ++state.generation;
        await this.load(state, next, performance.now());
        return;
      }
      state.manifest = await this.manifest(sha);
      if (!this.isCurrent(state, generation)) return;
      this.updateToolbarStatus(state);
      this.updateLanguageButton(state);
      if (state.manifest?.stage === 'ready') this.scheduleTranslationRefresh(state, 0);
    } catch (error) {
      this.context.log.warn('读取处理状态失败', error);
    }
  }

  private showWaiting(state: LeafState, message: string): void {
    state.waiting?.remove();
    const waiting = state.content.createDiv({ cls: 'pdf-reader-processing', attr: { role: 'status', 'aria-live': 'polite', 'data-pw-ui': '' } });
    state.waiting = waiting;
    waiting.createSpan({ text: message });
    waiting.createEl('button', { text: '继续原 PDF' }).addEventListener('click', () => this.exit(state));
  }

  /** Status panel over the native PDF while there is nothing to read yet. */
  private showStatus(state: LeafState): void {
    if (!state.desired || state.root || !state.sha) return;
    if (!state.waiting?.isConnected) {
      state.waiting = state.content.createDiv({ cls: 'pdf-reader-processing', attr: { 'aria-live': 'polite', 'data-pw-ui': '' } });
    }
    const view = describeStatus({
      ...(state.manifest ? { manifest: state.manifest } : {}),
      ...withProgress('parse', this.parseProgress.get(state.sha)),
      ...withProgress('translation', this.translationProgress.get(state.sha)),
      conflicts: state.conflicts,
      pipelineLoaded: Boolean(this.context.services.pipeline),
    });
    renderStatus(state.waiting, view, { action: action => this.runAction(state, action), close: () => this.exit(state) });
  }

  private runAction(state: LeafState, action: StatusAction): void {
    const pipeline = this.context.services.pipeline;
    const sha = state.sha;
    if (!pipeline) { new Notice('文献库模块未加载，无法处理这篇 PDF。'); return; }
    if (action === 'request') { this.askConsent(state); return; }
    if (!sha) return;
    if (action === 'prioritize') { pipeline.prioritize(sha); new Notice('已优先处理这篇。'); }
    else { pipeline.retry(sha); new Notice('已重新排队。'); }
    void this.refreshStatus(state);
  }

  private askConsent(state: LeafState): void {
    new ConfirmModal(this.context.app, '解析这篇 PDF？',
      `《${state.file.basename}》不在文献库的处理记录里。解析会把 PDF 上传到 MinerU 云端，消耗解析额度；完成后自动翻译。原 PDF 不会被修改。`,
      '上传并解析',
      () => {
        const pipeline = this.context.services.pipeline;
        if (!pipeline) { new Notice('文献库模块未加载，无法处理这篇 PDF。'); return; }
        pipeline.requestParse(state.file.path).then(
          () => this.refreshStatus(state),
          (error: unknown) => {
            this.context.log.warn('请求解析失败', error);
            new Notice(`请求解析失败：${error instanceof Error ? error.message : String(error)}`);
          },
        );
      }).open();
  }

  private isCurrent(state: LeafState, generation: number): boolean {
    const file = (state.view as FileView).file;
    return !this.disposed && state.desired && state.generation === generation && state.view === state.leaf.view && file?.path === state.filePath
      && file.stat.mtime === state.revision && state.content.isConnected && state.view.containerEl.isConnected && state.view.containerEl.ownerDocument === state.document;
  }

  private async mount(state: LeafState, generation: number, timing: { started: number; loaded: number; cached: boolean }): Promise<void> {
    const paper = state.paper;
    const sha = state.sha;
    if (!paper || !sha) return;
    const document = paper.document;
    state.shell?.remove();
    const native = Array.from(state.content.children).filter(element => !element.classList.contains('pdf-reader-processing')) as HTMLElement[];
    const shell = state.content.createDiv({ cls: 'pdf-reader-shell' });
    state.shell = shell;
    const toolbar = shell.createDiv({ cls: 'pdf-reader-toolbar', attr: { 'data-pw-ui': '' } });
    state.pageLabel = toolbar.createSpan({ cls: 'pdf-reader-page-label', text: `PDF p.${state.page}` });
    const pageInput = toolbar.createEl('input', { type: 'number', cls: 'pdf-reader-page-input', attr: { min: '1', max: String(document.pageCount), 'aria-label': '跳转原文页码' } });
    state.pageInput = pageInput;
    pageInput.value = String(state.page);
    pageInput.addEventListener('change', () => this.navigateReader(state, clampNumber(Number(pageInput.value), 1, document.pageCount, 1)));
    const smaller = toolbar.createEl('button', { text: 'A−', attr: { 'aria-label': '减小字号' } });
    const larger = toolbar.createEl('button', { text: 'A+', attr: { 'aria-label': '增大字号' } });
    for (const [control, delta] of [[smaller, -1], [larger, 1]] as const) {
      control.addEventListener('click', () => {
        this.settings.fontSize = clampNumber(this.settings.fontSize + delta, FONT_SIZE.min, FONT_SIZE.max, FONT_SIZE.default);
        this.refreshTypography();
        void this.context.saveSettings();
      });
    }
    const languageToggle = toolbar.createEl('button', { cls: 'pw-reader-language' });
    state.languageButton = languageToggle;
    languageToggle.addEventListener('click', () => this.switchLanguage(state, state.language === 'zh' ? 'en' : 'zh'));
    const search = toolbar.createEl('input', { type: 'search', placeholder: '查找正文', attr: { 'aria-label': '查找阅读内容' } });
    state.search = search;
    state.statusLabel = toolbar.createSpan({ cls: 'pdf-reader-status' });
    const warningsSlot = toolbar.createSpan();
    toolbar.createEl('button', { text: '原 PDF' }).addEventListener('click', () => this.exit(state));

    if (!this.translationsAvailable(state)) state.language = 'en';
    const root = shell.createDiv({ cls: 'pdf-reader-content', attr: { 'data-pdf-reader-active': 'false', 'data-lang': state.language, tabindex: '0', 'aria-label': 'PDF 单栏阅读内容' } });
    state.root = root;
    if (paper.zhScale !== undefined) setZhScale(root, paper.zhScale);
    root.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); search.focus(); }
    });
    root.addEventListener('copy', event => copyVisibleText(root, event));
    let searchIndex = 0;
    const find = () => {
      root.querySelectorAll('.pdf-reader-search-hit').forEach(element => element.classList.remove('pdf-reader-search-hit'));
      const term = search.value.trim().toLowerCase();
      if (!term) return;
      const matches = Array.from(root.querySelectorAll<HTMLElement>('[data-reader-block-id]')).filter(element => blockSearchText(element).toLowerCase().includes(term));
      const match = matches[searchIndex % matches.length];
      if (!match) return;
      match.closest('details')?.setAttribute('open', '');
      match.classList.add('pdf-reader-search-hit');
      match.scrollIntoView({ block: 'center' });
    };
    search.addEventListener('input', () => { searchIndex = 0; find(); });
    search.addEventListener('keydown', event => { if (event.key === 'Enter') { searchIndex++; find(); } });
    this.updateLanguageButton(state);
    this.updateToolbarStatus(state);

    const translations = paper.translations;
    state.mounting = generation;
    try {
      await renderReader(root, document.blocks, {
        fontSize: this.settings.fontSize, lineHeight: this.settings.lineHeight, language: state.language,
        assetUrl: reference => {
          const asset = document.assets[reference];
          return asset ? this.context.store.assetUrl(sha, asset.path) : '';
        },
        assetDimensions: reference => {
          const asset = document.assets[reference];
          return asset?.width && asset.height ? { width: asset.width, height: asset.height } : undefined;
        },
        ...(translations ? { translation: (hash: string) => translations.entries[hash]?.text } : {}),
        isCurrent: () => this.isCurrent(state, generation),
        onSource: page => this.showOriginal(state, page),
        onCopy: page => void this.copySource(state, page),
        onZoom: (url, caption) => new FigureModal(this.context.app, url, caption).open(),
      });
    } finally {
      if (state.mounting === generation) state.mounting = undefined;
    }
    if (!this.isCurrent(state, generation)) { shell.remove(); return; }
    if (state.pendingTranslations) {
      state.pendingTranslations = false;
      await this.refreshTranslations(state, generation);
      if (!this.isCurrent(state, generation)) { shell.remove(); return; }
    }
    setLanguage(root, state.language);
    const rendered = performance.now();
    if (paper.zhScale === undefined && translations) {
      const scale = measureZhScale(root);
      if (scale !== undefined) { paper.zhScale = scale; setZhScale(root, scale); }
    }
    if (document.warnings.length) {
      warningsSlot.createEl('button', { cls: 'pdf-reader-warnings', text: `核对提示 ${document.warnings.length}` })
        .addEventListener('click', () => new MessageModal(this.context.app, document.warnings).open());
    }
    state.waiting?.remove();
    state.waiting = undefined;
    state.nativeElements = native.map(element => ({ element, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') }));
    for (const { element } of state.nativeElements) { element.addClass('pw-reader-native-hidden'); element.inert = true; element.setAttribute('aria-hidden', 'true'); }
    state.content.addClass('pdf-reading-mode-active');
    root.dataset.pdfReaderActive = 'true';
    this.emitMode(state);
    this.navigateReader(state, state.page);
    state.stopImageDecoding = prepareNearbyImages(root);
    state.pageTracker = createSourcePageTracker(root, current => {
      state.page = current;
      pageInput.value = String(current);
      if (state.pageLabel) state.pageLabel.textContent = `PDF p.${current} / ${document.pageCount}`;
      const win = state.document.defaultView!;
      win.clearTimeout(state.saveTimer);
      state.saveTimer = win.setTimeout(() => this.savePosition(sha, state.page), 800);
    });
    if (!this.settings.scrollDiagnostics) return;
    const win = state.document.defaultView!;
    win.requestAnimationFrame(() => {
      const open: OpenTiming = {
        cached: timing.cached, blocks: document.blocks.length,
        loadMs: round(timing.loaded - timing.started), renderMs: round(rendered - timing.loaded), firstScreenMs: round(performance.now() - timing.started),
      };
      this.context.log.info(`阅读模式首屏 ${open.firstScreenMs} ms（${open.cached ? '内存缓存' : '读取存储'}，${open.blocks} 块）`);
      const reports: object[] = [];
      const write = () => void this.writeDiagnostics(sha, { open, reports });
      write();
      state.stopScrollProfile = observeScrollPerformance(root, (report: ScrollPerformanceReport) => {
        if (!this.isCurrent(state, generation)) return;
        reports.push({ ...report, pageIndex: state.pageTracker?.getStats() });
        if (reports.length > 12) reports.shift();
        write();
      });
    });
  }

  private translationsAvailable(state: LeafState): boolean {
    const entries = state.paper?.translations?.entries;
    return Boolean(entries && Object.keys(entries).length);
  }

  private switchLanguage(state: LeafState, language: Language): void {
    if (!state.root || (language === 'zh' && !this.translationsAvailable(state))) return;
    state.language = language;
    setLanguage(state.root, language);
    this.updateLanguageButton(state);
    this.emitMode(state);
  }

  private updateLanguageButton(state: LeafState): void {
    const button = state.languageButton;
    if (!button || !state.sha) return;
    const view = languageButton(state.language, state.manifest, state.paper?.translations, this.translationProgress.get(state.sha));
    button.textContent = view.text;
    button.disabled = !view.enabled;
    button.setAttribute('aria-label', view.title);
    button.setAttribute('aria-pressed', String(state.language === 'zh'));
    button.title = view.title;
  }

  private updateToolbarStatus(state: LeafState): void {
    const label = state.statusLabel;
    if (!label) return;
    label.empty();
    const manifest = state.manifest;
    if (state.conflicts.length) {
      label.setText(`存储冲突：${state.conflicts.join('、')}`);
      label.addClass('is-error');
      return;
    }
    label.removeClass('is-error');
    if (manifest?.stage === 'failed' && manifest.failure) {
      label.addClass('is-error');
      label.createSpan({ text: `${stageLabel(manifest.failure.stage)}阶段失败`, title: manifest.failure.error });
      if (this.context.services.pipeline) {
        label.createEl('button', { text: '重试' }).addEventListener('click', () => this.runAction(state, 'retry'));
      }
    } else if (manifest && manifest.stage !== 'ready' && manifest.stage !== 'translating') {
      label.setText(stageLabel(manifest.stage));
    }
  }

  /** New translations while reading: rebuild only the Chinese layers that changed, at most every few seconds. */
  private scheduleTranslationRefresh(state: LeafState, delay = TRANSLATION_REFRESH_MS): void {
    const win = state.document.defaultView;
    if (!win || !state.root || (state.translationTimer !== undefined && delay > 0)) return;
    win.clearTimeout(state.translationTimer);
    const generation = state.generation;
    state.translationTimer = win.setTimeout(() => {
      state.translationTimer = undefined;
      void this.refreshTranslations(state, generation);
    }, delay);
  }

  private async refreshTranslations(state: LeafState, generation: number): Promise<void> {
    const { paper, sha, root } = state;
    if (!paper || !sha || !root || !this.isCurrent(state, generation)) return;
    if (state.mounting === generation) { state.pendingTranslations = true; return; }
    try {
      const translations = await this.cache.refreshTranslations(sha);
      if (!this.isCurrent(state, generation) || !translations) return;
      paper.translations = translations;
      const changed = await updateTranslations(root, paper.document.blocks, hash => translations.entries[hash]?.text, { isCurrent: () => this.isCurrent(state, generation) });
      if (changed && paper.zhScale === undefined) {
        const scale = measureZhScale(root);
        if (scale !== undefined) { paper.zhScale = scale; setZhScale(root, scale); }
      }
      this.updateLanguageButton(state);
    } catch (error) {
      this.context.log.warn('刷新译文失败', error);
    }
  }

  private savePosition(sha: string, page: number): void {
    if (this.settings.positions[sha] === page) return;
    this.settings.positions[sha] = page;
    void this.context.saveSettings();
  }

  private navigateReader(state: LeafState, page: number): void {
    state.page = page;
    if (!state.root) return;
    scrollToSourcePage(state.root, page);
    if (state.pageInput) state.pageInput.value = String(page);
    if (state.pageLabel) state.pageLabel.textContent = `PDF p.${page} / ${state.paper?.document.pageCount ?? '?'}`;
  }

  /** Rebuild after the file or its document changed, keeping the reading position. */
  private reopen(state: LeafState): void {
    const file = (state.view as FileView).file;
    if (file) state.revision = file.stat.mtime;
    if (!state.desired) return;
    const page = state.root ? (state.pageTracker?.getPage() ?? state.page) : state.page;
    this.exit(state, false);
    state.paper = undefined;
    state.reopenPage = page || undefined;
    void this.toggle(state);
  }

  private exit(state: LeafState, synchronize = true): void {
    const wasActive = state.root?.dataset.pdfReaderActive === 'true';
    const page = state.pageTracker?.getPage() ?? (state.root ? getVisibleSourcePage(state.root) || state.page : state.page);
    state.pageTracker?.dispose(); state.pageTracker = undefined;
    state.stopScrollProfile?.(); state.stopScrollProfile = undefined;
    state.stopImageDecoding?.(); state.stopImageDecoding = undefined;
    state.document.defaultView?.clearTimeout(state.saveTimer);
    state.document.defaultView?.clearTimeout(state.translationTimer);
    state.translationTimer = undefined;
    state.pendingTranslations = false;
    if (wasActive && state.sha) this.savePosition(state.sha, page);
    const wasDesired = state.desired;
    state.desired = false;
    state.generation++;
    state.waiting?.remove(); state.waiting = undefined;
    if (state.root) state.root.dataset.pdfReaderActive = 'false';
    if (wasDesired) this.emitMode(state);
    for (const saved of state.nativeElements) {
      saved.element.removeClass('pw-reader-native-hidden');
      saved.element.inert = saved.inert;
      if (saved.ariaHidden === null) saved.element.removeAttribute('aria-hidden');
      else saved.element.setAttribute('aria-hidden', saved.ariaHidden);
    }
    state.nativeElements = [];
    state.shell?.remove();
    state.shell = state.root = state.pageLabel = state.pageInput = state.search = state.languageButton = state.statusLabel = undefined;
    state.content.removeClass('pdf-reading-mode-active');
    if (!this.disposed) this.context.services.pdfToolbar.refresh();
    if (wasActive && synchronize) {
      state.content.getBoundingClientRect();
      state.originalEphemeral.call(state.view, { subpath: `#page=${page}`, focus: false });
    }
  }

  private emitMode(state: LeafState): void {
    this.context.events.emit('reader:mode-change', {
      leafId: leafId(state.leaf),
      active: state.root?.dataset.pdfReaderActive === 'true' && state.desired,
      language: state.language,
    });
  }

  private showOriginal(state: LeafState, page: number): void {
    this.exit(state, false);
    state.content.getBoundingClientRect();
    state.originalEphemeral.call(state.view, { subpath: `#page=${page}`, focus: true });
  }

  private async copySource(state: LeafState, page: number): Promise<void> {
    // Follow the vault's link format settings (wikilink/Markdown, path style).
    const link = this.context.app.fileManager.generateMarkdownLink(state.file, '', `#page=${page}`, `PDF p.${page}`);
    await state.document.defaultView!.navigator.clipboard.writeText(link);
    new Notice('原 PDF 页码链接已复制', 1800);
  }

  /** Device-local diagnostics in the plugin folder; numbers only, never paper text. */
  private async writeDiagnostics(sha: string, data: { open: OpenTiming; reports: object[] }): Promise<void> {
    try {
      const directory = path.join(this.context.pluginDir, 'diagnostics');
      await fs.mkdir(directory, { recursive: true });
      const profile = { version: this.context.plugin.manifest.version, paper: sha.slice(0, 12), at: new Date().toISOString(), ...data };
      await fs.writeFile(path.join(directory, `reader-${sha.slice(0, 12)}.json`), JSON.stringify(profile, null, 2) + '\n');
    } catch (error) {
      this.context.log.warn('写入阅读诊断失败', error);
    }
  }
}

/** Copy only what is visible: no hidden language layer, page markers or tool buttons. */
export function copyVisibleText(root: HTMLElement, event: ClipboardEvent): void {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !event.clipboardData) return;
  // Detached scratch space; text extraction does not depend on the owning window.
  const container = createFragment();
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    if (!root.contains(range.commonAncestorContainer)) return;
    const wrapper = container.createDiv();
    wrapper.append(range.cloneContents());
  }
  if (!needsCleanCopy(container)) return;
  event.preventDefault();
  event.clipboardData.setData('text/plain', Array.from(container.children, child => readableText(child)).join('\n'));
}

function withProgress<K extends 'parse' | 'translation'>(key: K, progress: Progress | undefined): Partial<Record<K, Progress>> {
  return progress ? { [key]: progress } as Record<K, Progress> : {};
}

function round(value: number): number { return Math.round(value * 10) / 10; }

function currentNativePage(state: LeafState): number | undefined {
  const container = state.content.getBoundingClientRect();
  let best = 0;
  let page: number | undefined;
  for (const element of Array.from(state.content.querySelectorAll<HTMLElement>('.page[data-page-number]'))) {
    const rect = element.getBoundingClientRect();
    const area = Math.max(0, Math.min(container.bottom, rect.bottom) - Math.max(container.top, rect.top));
    if (area > best) { best = area; page = Number(element.dataset.pageNumber); }
  }
  const current = state.content.querySelector<HTMLInputElement>('.page-number input, input.page-number, input[type="number"]');
  return page || Number(current?.value) || undefined;
}

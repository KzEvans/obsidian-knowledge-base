import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webUtils } from 'electron';
import { MarkdownRenderer, Notice, setIcon } from 'obsidian';
import type { App, CachedMetadata, Component , MarkdownView, TFile} from 'obsidian';
import type { ModuleContext } from '../../core/module';
import { errorMessage } from '../../core/secrets';
import type { AgentEvent } from '../cli/adapter';
import { PURPOSE_PATH } from '../notes/metadata';
import { confirm } from '../notes/controller';
import { fullText } from '../../../skills/paper-note/fulltext';
import { currentAgent } from '../runner';
import type { AgentSettings, AttachmentSummary, ChatMessage, ChatSession } from '../settings';
import { CHAT_INSTRUCTIONS, MAX_ATTACHMENTS, MAX_IMAGE_ATTACHMENT_BYTES, MAX_OUTLINK_NOTES, buildChatPrompt } from './prompt';
import type { PromptAttachment } from './prompt';
import { insertQuestionAnswerSection, normalizeLatexDelimiters } from './qa';
import { sessionFor, trimSession } from './sessions';

const PANEL_MARGIN = 12;
const PANEL_MIN_WIDTH = 340;
const PANEL_MIN_HEIGHT = 360;
const CHAT_TIMEOUT_MS = 20 * 60_000;
const DIRECTIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;

interface PendingAttachment extends PromptAttachment { size: number }

interface NoteContext {
  file: TFile;
  selection: string;
  outlinks: TFile[];
  paper?: { sha: string; pdfPath: string };
}

interface Refs {
  panel: HTMLElement;
  header: HTMLElement;
  noteTitle: HTMLElement;
  contextArea: HTMLElement;
  contextBody: HTMLElement;
  contextSummary: HTMLElement;
  contextToggle: HTMLButtonElement;
  chips: HTMLElement;
  captureButton: HTMLButtonElement;
  refreshButton: HTMLButtonElement;
  selectionInput: HTMLInputElement;
  selectionText: HTMLElement;
  outlinksInput: HTMLInputElement;
  outlinksText: HTMLElement;
  messages: HTMLElement;
  input: HTMLTextAreaElement;
  attachmentButton: HTMLButtonElement;
  attachmentButtonText: HTMLElement;
  attachmentInput: HTMLInputElement;
  attachmentList: HTMLElement;
  status: HTMLElement;
  writeButton: HTMLButtonElement;
  sendButton: HTMLButtonElement;
  newChatButton: HTMLButtonElement;
}

/** The floating note Q&A window (codex-note-chat behavior; always read-only). */
export class NoteChat {
  private refs?: Refs;
  private visible = false;
  private view: MarkdownView | null = null;
  private noteContext: NoteContext | null = null;
  private attachments: PendingAttachment[] = [];
  private active?: AbortController;
  private preparing = false;
  private disposed = false;
  private drag?: { pointerId: number; startX: number; startY: number; left: number; top: number };
  private resize?: { pointerId: number; direction: string; startX: number; startY: number; left: number; top: number; right: number; bottom: number };
  private selectionTimer = 0;
  private saveTimer = 0;

  constructor(private readonly context: ModuleContext<AgentSettings>, private readonly component: Component) {}

  private get app(): App { return this.context.app; }
  private get settings(): AgentSettings { return this.context.settings; }

  get boundPath(): string | undefined { return this.noteContext?.file.path; }

  toggle(view: MarkdownView): void {
    if (!view.file) { new Notice('当前标签页没有可读取的笔记'); return; }
    if (this.visible && this.noteContext?.file.path === view.file.path) { this.close(); return; }
    void this.open(view);
  }

  async open(view: MarkdownView): Promise<void> {
    const refs = this.refs ?? this.create();
    if (this.noteContext && view.file && this.noteContext.file.path !== view.file.path) {
      this.attachments = [];
      this.renderAttachments();
    }
    this.view = view;
    this.visible = true;
    refs.panel.show();
    refs.panel.setAttribute('aria-hidden', 'false');
    this.applyWindowState();
    await this.refreshContext();
    this.renderMessages();
    window.setTimeout(() => refs.input.focus(), 30);
  }

  close(): void {
    if (!this.refs) return;
    this.captureWindowState();
    this.visible = false;
    this.refs.panel.hide();
    this.refs.panel.setAttribute('aria-hidden', 'true');
    this.scheduleSave();
  }

  /** The bound note was renamed: its session already moved; refresh the title. */
  noteRenamed(file: TFile): void {
    if (this.noteContext && this.view?.file === file) void this.refreshContext();
  }

  onActiveLeafChange(): void {
    if (this.visible && this.view && !this.view.file) this.close();
  }

  onSelectionChange(): void {
    if (!this.visible || !this.noteContext) return;
    window.clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(() => {
      const selection = this.readSelection();
      if (!this.noteContext || !selection || selection === this.noteContext.selection) return;
      this.noteContext.selection = selection;
      this.renderContext();
    }, 100);
  }

  onWindowResize(): void { this.constrain(); }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.selectionTimer);
    window.clearTimeout(this.saveTimer);
    this.active?.abort();
    this.captureWindowState();
    this.refs?.panel.remove();
    this.refs = undefined;
  }

  // ---- DOM ----

  private create(): Refs {
    const panel = activeDocument.body.createEl('section', { cls: 'pw-chat-window', attr: { role: 'dialog', 'aria-modal': 'false', 'aria-label': '笔记问答', 'aria-hidden': 'true' } });
    panel.hide();

    const header = panel.createEl('header', { cls: 'pw-chat-header', attr: { tabindex: '0', 'aria-label': '拖动问答窗口；也可使用方向键移动' } });
    const titleGroup = header.createDiv({ cls: 'pw-chat-title-group' });
    titleGroup.createDiv({ cls: 'pw-chat-title', text: '笔记问答' });
    const noteTitle = titleGroup.createDiv({ cls: 'pw-chat-note-title', text: '尚未绑定笔记' });
    const headerActions = header.createDiv({ cls: 'pw-chat-header-actions' });
    const newChatButton = iconButton(headerActions, 'rotate-ccw', '开始新对话', () => void this.startNewConversation());
    iconButton(headerActions, 'x', '关闭问答窗口', () => this.close());

    const contextArea = panel.createEl('section', { cls: 'pw-chat-context' });
    const contextTop = contextArea.createDiv({ cls: 'pw-chat-context-top' });
    const heading = contextTop.createDiv({ cls: 'pw-chat-context-heading' });
    heading.createSpan({ cls: 'pw-chat-section-label', text: '本轮上下文' });
    const contextSummary = heading.createSpan({ cls: 'pw-chat-context-summary', text: '正在读取…' });
    const contextActions = contextTop.createDiv({ cls: 'pw-chat-context-actions' });
    const captureButton = contextActions.createEl('button', { cls: 'pw-chat-context-action', text: '捕获选区', attr: { type: 'button', title: '在笔记中选择文字后，点击这里加入本轮上下文' } });
    captureButton.addEventListener('click', () => this.captureSelection());
    const refreshButton = iconButton(contextActions, 'refresh-cw', '刷新笔记上下文', () => void this.refreshContext(true));
    const contextToggle = iconButton(contextActions, 'chevron-up', '收起本轮上下文', () => this.setContextCollapsed(!this.settings.contextCollapsed));
    contextToggle.addClass('pw-chat-context-toggle');
    contextToggle.setAttribute('aria-controls', 'pw-chat-context-body');
    const contextBody = contextArea.createDiv({ cls: 'pw-chat-context-body', attr: { id: 'pw-chat-context-body' } });
    const chips = contextBody.createDiv({ cls: 'pw-chat-chips' });
    const options = contextBody.createDiv({ cls: 'pw-chat-options' });
    const selection = checkbox(options, '加入选中文本', this.settings.includeSelection);
    const outlinks = checkbox(options, '加入出链笔记', this.settings.includeOutlinks);
    selection.input.addEventListener('change', () => { this.settings.includeSelection = selection.input.checked; this.updateSummary(); this.scheduleSave(); });
    outlinks.input.addEventListener('change', () => { this.settings.includeOutlinks = outlinks.input.checked; this.updateSummary(); this.scheduleSave(); });

    const messages = panel.createDiv({ cls: 'pw-chat-messages', attr: { role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions text' } });

    const composer = panel.createEl('footer', { cls: 'pw-chat-composer' });
    const composerTop = composer.createDiv({ cls: 'pw-chat-composer-top' });
    composerTop.createEl('label', { cls: 'pw-chat-input-label', text: '向当前笔记提问', attr: { for: 'pw-chat-question' } });
    const attachmentButton = composerTop.createEl('button', { cls: 'pw-chat-attachment-button', attr: { type: 'button', title: '添加文件或图片', 'aria-label': '添加文件或图片' } });
    setIcon(attachmentButton.createSpan({ cls: 'pw-chat-attachment-icon' }), 'paperclip');
    const attachmentButtonText = attachmentButton.createSpan({ text: '添加附件' });
    const input = composer.createEl('textarea', { cls: 'pw-chat-input', attr: { id: 'pw-chat-question', rows: '3', placeholder: '例如：这篇论文的关键机制是什么？', 'aria-label': '向当前笔记提问' } });
    const attachmentList = composer.createDiv({ cls: 'pw-chat-attachments', attr: { 'aria-live': 'polite' } });
    const actions = composer.createDiv({ cls: 'pw-chat-composer-actions' });
    const status = actions.createDiv({ cls: 'pw-chat-status', text: '只读模式', attr: { role: 'status' } });
    const buttons = actions.createDiv({ cls: 'pw-chat-button-group' });
    const writeButton = buttons.createEl('button', { cls: 'pw-chat-secondary', text: '写入笔记', attr: { type: 'button', title: '将尚未保存的对话追加到当前笔记的“提问”一节' } });
    writeButton.addEventListener('click', () => void this.writeToNote());
    const sendButton = buttons.createEl('button', { cls: 'mod-cta pw-chat-send', text: '发送', attr: { type: 'button' } });
    sendButton.addEventListener('click', () => { if (this.active) this.active.abort(); else void this.send(); });
    const attachmentInput = composer.createEl('input', { cls: 'pw-chat-file-input', attr: { type: 'file', multiple: '', 'aria-hidden': 'true' } });
    attachmentInput.hide();
    attachmentButton.addEventListener('click', () => attachmentInput.click());
    attachmentInput.addEventListener('change', () => { this.addAttachments(Array.from(attachmentInput.files ?? [])); attachmentInput.value = ''; });

    const handles = DIRECTIONS.map(direction => panel.createDiv({ cls: `pw-chat-resize-handle is-${direction}`, attr: { 'data-direction': direction, 'aria-hidden': 'true' } }));

    const refs: Refs = {
      panel, header, noteTitle, contextArea, contextBody, contextSummary, contextToggle, chips, captureButton, refreshButton,
      selectionInput: selection.input, selectionText: selection.text, outlinksInput: outlinks.input, outlinksText: outlinks.text,
      messages, input, attachmentButton, attachmentButtonText, attachmentInput, attachmentList, status, writeButton, sendButton, newChatButton,
    };
    this.refs = refs;
    this.setContextCollapsed(this.settings.contextCollapsed, false);
    this.renderAttachments();

    const component = this.component;
    component.registerDomEvent(input, 'keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!this.active) void this.send();
      } else if (event.key === 'Escape' && !this.active) this.close();
    });
    component.registerDomEvent(header, 'pointerdown', event => this.startDrag(event));
    component.registerDomEvent(header, 'keydown', event => this.moveWithKeyboard(event));
    for (const handle of handles) component.registerDomEvent(handle, 'pointerdown', event => this.startResize(event, handle));
    component.registerDomEvent(activeDocument, 'pointermove', event => { this.continueDrag(event); this.continueResize(event); });
    const end = (event: PointerEvent) => { this.stopDrag(event); this.stopResize(event); };
    component.registerDomEvent(activeDocument, 'pointerup', end);
    component.registerDomEvent(activeDocument, 'pointercancel', end);
    const observer = new ResizeObserver(() => { if (this.visible && !this.drag && !this.resize) this.captureWindowState(); });
    observer.observe(panel);
    component.register(() => observer.disconnect());
    return refs;
  }

  private setContextCollapsed(collapsed: boolean, persist = true): void {
    this.settings.contextCollapsed = collapsed;
    const refs = this.refs;
    if (refs) {
      refs.contextArea.toggleClass('is-collapsed', collapsed);
      refs.contextBody.toggle(!collapsed);
      refs.contextToggle.setAttribute('aria-expanded', String(!collapsed));
      const label = collapsed ? '展开本轮上下文' : '收起本轮上下文';
      refs.contextToggle.setAttribute('aria-label', label);
      refs.contextToggle.title = label;
      refs.contextToggle.empty();
      setIcon(refs.contextToggle, collapsed ? 'chevron-down' : 'chevron-up');
    }
    if (persist) this.scheduleSave();
  }

  // ---- context ----

  private async refreshContext(showNotice = false): Promise<void> {
    const file = this.view?.file;
    if (!file || !this.refs) return;
    const cache = this.app.metadataCache.getFileCache(file) ?? {};
    const previous = this.noteContext?.file.path === file.path ? this.noteContext.selection : '';
    this.noteContext = { file, selection: this.readSelection() || previous, outlinks: this.outlinksOf(file, cache), paper: await this.paperOf(file, cache) };
    this.refs.noteTitle.setText(file.basename);
    this.renderContext();
    if (showNotice) new Notice('已刷新当前笔记上下文');
  }

  private async paperOf(file: TFile, cache: CachedMetadata): Promise<NoteContext['paper']> {
    const frontmatter = cache.frontmatter;
    let sha = typeof frontmatter?.source_sha256 === 'string' && /^[0-9a-f]{64}$/.test(frontmatter.source_sha256) ? frontmatter.source_sha256 : undefined;
    const candidates = [typeof frontmatter?.source_pdf === 'string' ? frontmatter.source_pdf : '', ...(cache.links ?? []).map(link => link.link)];
    let pdfPath = '';
    for (const candidate of candidates) {
      const target = linkTarget(candidate);
      if (!target.toLowerCase().endsWith('.pdf')) continue;
      const pdf = this.app.metadataCache.getFirstLinkpathDest(target, file.path);
      if (pdf) { pdfPath = pdf.path; break; }
    }
    try {
      if (!sha && pdfPath) sha = await this.context.store.shaForPath(pdfPath);
      if (!sha || !(await this.context.store.document(sha))) return undefined;
    } catch (error) {
      this.context.log.warn('读取论文解析结果失败', error);
      return undefined;
    }
    return { sha, pdfPath: pdfPath || '（解析存储）' };
  }

  private outlinksOf(file: TFile, cache: CachedMetadata): TFile[] {
    const seen = new Set<string>();
    const notes: TFile[] = [];
    for (const link of cache.links ?? []) {
      const target = linkTarget(link.link);
      if (!target) continue;
      const resolved = this.app.metadataCache.getFirstLinkpathDest(target, file.path);
      if (!resolved || resolved.extension !== 'md' || resolved.path === file.path || seen.has(resolved.path)) continue;
      seen.add(resolved.path);
      notes.push(resolved);
    }
    return notes;
  }

  private readSelection(): string {
    const view = this.view;
    if (!view) return '';
    try {
      const container = view.contentEl;
      const domSelection = () => {
        const selection = container.ownerDocument.defaultView?.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return '';
        if (!container.contains(selection.anchorNode) || !container.contains(selection.focusNode)) return '';
        return selection.toString().trim();
      };
      if (view.getMode() === 'preview') return domSelection();
      return view.editor.getSelection().trim() || domSelection();
    } catch {
      return '';
    }
  }

  private captureSelection(): void {
    if (!this.noteContext || !this.refs) return;
    const selection = this.readSelection() || this.noteContext.selection;
    if (!selection) { new Notice('请先在当前笔记中选择文字，再点击“捕获选区”'); return; }
    this.noteContext.selection = selection;
    this.settings.includeSelection = true;
    this.refs.selectionInput.checked = true;
    this.renderContext();
    this.scheduleSave();
    new Notice(`已捕获 ${selection.length} 字选区并加入上下文`);
  }

  private renderContext(): void {
    const refs = this.refs;
    const context = this.noteContext;
    if (!refs || !context) return;
    refs.chips.empty();
    chip(refs.chips, 'file-text', `笔记 · ${context.file.basename}`, false);
    if (context.paper) chip(refs.chips, 'file', '论文全文 · 解析存储', false);
    else chip(refs.chips, 'circle-alert', '未找到已解析的来源论文', true);
    const hasSelection = !!context.selection;
    refs.selectionInput.disabled = !hasSelection;
    refs.selectionInput.checked = hasSelection && this.settings.includeSelection;
    refs.selectionText.setText(hasSelection ? `加入已捕获选区（${context.selection.length} 字）` : '加入选中文本（先选择，再点“捕获选区”）');
    const count = Math.min(context.outlinks.length, MAX_OUTLINK_NOTES);
    refs.outlinksInput.disabled = count === 0;
    refs.outlinksInput.checked = count > 0 && this.settings.includeOutlinks;
    refs.outlinksText.setText(`加入出链笔记（${count} 篇${context.outlinks.length > count ? `，共 ${context.outlinks.length} 篇` : ''}）`);
    this.updateSummary();
  }

  private updateSummary(): void {
    const refs = this.refs;
    const context = this.noteContext;
    if (!refs) return;
    if (!context) { refs.contextSummary.setText('正在读取…'); return; }
    const parts = [context.paper ? '笔记 + 论文全文' : '仅笔记'];
    if (refs.selectionInput.checked && context.selection) parts.push('选区');
    if (refs.outlinksInput.checked && context.outlinks.length) parts.push(`${Math.min(context.outlinks.length, MAX_OUTLINK_NOTES)} 篇出链`);
    refs.contextSummary.setText(parts.join(' · '));
  }

  // ---- attachments ----

  private addAttachments(files: File[]): void {
    let skipped = 0;
    for (const file of files) {
      if (this.attachments.length >= MAX_ATTACHMENTS) { skipped += 1; continue; }
      const filePath = localPath(file);
      if (!filePath || !path.isAbsolute(filePath)) { skipped += 1; continue; }
      const isImage = file.type.startsWith('image/') || /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(filePath);
      if (isImage && file.size > MAX_IMAGE_ATTACHMENT_BYTES) { skipped += 1; continue; }
      if (this.attachments.some(attachment => attachment.path === filePath)) continue;
      this.attachments.push({ name: file.name || path.basename(filePath), path: filePath, type: file.type, size: file.size, isImage });
    }
    this.renderAttachments();
    if (skipped) new Notice(`有 ${skipped} 个附件未加入；最多 ${MAX_ATTACHMENTS} 个，单张图片不超过 25 MB`);
  }

  private renderAttachments(): void {
    const refs = this.refs;
    if (!refs) return;
    refs.attachmentList.empty();
    refs.attachmentList.toggle(this.attachments.length > 0);
    refs.attachmentButtonText.setText(this.attachments.length ? `添加附件 (${this.attachments.length})` : '添加附件');
    for (const attachment of this.attachments) {
      const item = refs.attachmentList.createDiv({ cls: 'pw-chat-attachment', attr: { title: attachment.path } });
      setIcon(item.createSpan({ cls: 'pw-chat-attachment-type' }), attachment.isImage ? 'image' : 'file');
      const copy = item.createSpan({ cls: 'pw-chat-attachment-copy' });
      copy.createSpan({ cls: 'pw-chat-attachment-name', text: attachment.name });
      copy.createSpan({ cls: 'pw-chat-attachment-meta', text: `${attachment.isImage ? '图片' : '文件'} · ${formatFileSize(attachment.size)}` });
      const remove = iconButton(item, 'x', `移除附件 ${attachment.name}`, () => {
        if (this.active) return;
        this.attachments = this.attachments.filter(other => other.path !== attachment.path);
        this.renderAttachments();
      });
      remove.addClass('pw-chat-attachment-remove');
      remove.disabled = !!this.active;
    }
  }

  // ---- messages ----

  private session(): ChatSession | undefined {
    return this.noteContext ? sessionFor(this.settings, this.noteContext.file.path) : undefined;
  }

  private renderMessages(): void {
    const refs = this.refs;
    const session = this.session();
    if (!refs || !session) return;
    refs.messages.empty();
    if (!session.messages.length) {
      const empty = refs.messages.createDiv({ cls: 'pw-chat-empty' });
      setIcon(empty.createDiv({ cls: 'pw-chat-empty-icon' }), 'messages-square');
      empty.createDiv({ cls: 'pw-chat-empty-title', text: '从这篇笔记开始提问' });
      empty.createDiv({ cls: 'pw-chat-empty-copy', text: '当前笔记和论文全文会自动作为上下文；你还可以加入选中文本、出链笔记或本地附件。' });
    } else {
      for (const message of session.messages) this.appendMessage(message, false);
    }
    this.updateWriteButton();
    this.scrollToBottom();
  }

  private appendMessage(message: Pick<ChatMessage, 'role' | 'text' | 'attachments'>, streaming: boolean): HTMLElement {
    const refs = this.refs!;
    const row = refs.messages.createEl('article', { cls: `pw-chat-message is-${message.role}${streaming ? ' is-streaming' : ''}` });
    const agentName = (this.session()?.adapter ?? this.settings.adapter) === 'claude' ? 'Claude' : 'Codex';
    row.createDiv({ cls: 'pw-chat-message-label', text: message.role === 'user' ? '你' : message.role === 'error' ? '错误' : agentName });
    const content = row.createDiv({ cls: 'pw-chat-message-content' });
    if (streaming) { content.setText(message.text || '正在思考…'); return content; }
    const body = content.createDiv({ cls: 'pw-chat-markdown markdown-rendered' });
    if (message.role === 'error') body.setText(message.text);
    else {
      MarkdownRenderer.render(this.app, normalizeLatexDelimiters(message.text), body, this.noteContext?.file.path ?? '', this.component)
        .then(() => this.scrollToBottom())
        .catch(error => { this.context.log.warn('Markdown/LaTeX 渲染失败', error); body.setText(message.text); });
    }
    if (message.attachments?.length) {
      const list = content.createDiv({ cls: 'pw-chat-message-attachments' });
      for (const attachment of message.attachments) {
        const item = list.createSpan({ cls: 'pw-chat-message-attachment', attr: { title: `${attachment.name} · ${formatFileSize(attachment.size)}` } });
        setIcon(item.createSpan({ cls: 'pw-chat-message-attachment-icon' }), attachment.isImage ? 'image' : 'file');
        item.createSpan({ text: attachment.name });
      }
    }
    return content;
  }

  private async send(): Promise<void> {
    const refs = this.refs;
    if (this.active || this.preparing || this.disposed || !refs || !this.noteContext) return;
    const attachments = this.attachments.slice();
    const question = refs.input.value.trim() || (attachments.length ? '请分析这些附件。' : '');
    if (!question) { new Notice('请输入问题'); refs.input.focus(); return; }

    this.preparing = true;
    try { await this.refreshContext(); }
    finally { this.preparing = false; }
    if (this.disposed || !this.noteContext) return;
    const context = this.noteContext;
    const session = this.session()!;
    const notePath = context.file.path;
    session.messages.push({ role: 'user', text: question, attachments: attachments.map(summary), at: new Date().toISOString() });
    trimSession(session);
    refs.input.value = '';
    this.attachments = [];
    this.renderMessages();
    const streaming = this.appendMessage({ role: 'assistant', text: '正在准备上下文…' }, true);
    const controller = new AbortController();
    this.active = controller;
    this.setBusy(true);

    let streamed = '';
    try {
      if (session.threadId && session.adapter !== this.settings.adapter) {
        new Notice('已切换智能体，旧会话无法续接，本轮新开会话。');
        session.threadId = null;
      }
      session.adapter = this.settings.adapter;
      const resumable = !!session.threadId;
      const run = async (resumeId: string | null) => {
        const prompt = await this.buildPrompt(context, question, attachments, !!resumeId);
        const { adapter, model, reasoningEffort } = currentAgent(this.settings, session.adapter);
        const cwd = await chatDirectory();
        const readable = new Set([this.context.vaultPath, ...attachments.filter(attachment => !attachment.isImage).map(attachment => path.dirname(attachment.path))]);
        const events = adapter.run({
          prompt, instructions: CHAT_INSTRUCTIONS, cwd, readableDirs: [...readable], model, reasoningEffort, mode: 'read-only', timeoutMs: CHAT_TIMEOUT_MS,
          images: attachments.filter(attachment => attachment.isImage).map(attachment => attachment.path),
          resumeId: resumeId ?? undefined,
        }, controller.signal);
        return this.consume(events, session, text => { streamed += text; streaming.setText(streamed.trim() || '正在思考…'); this.scrollToBottom(); });
      };
      let answer: string;
      try {
        answer = await run(session.threadId);
      } catch (error) {
        if (!resumable || streamed || controller.signal.aborted) throw error;
        // A thread from codex-note-chat or a deleted session: start over once, with the full text.
        new Notice('无法续接旧会话，已新开会话。');
        session.threadId = null;
        answer = await run(null);
      }
      session.messages.push({ role: 'assistant', text: answer || '智能体未返回可显示的回答。', at: new Date().toISOString() });
    } catch (error) {
      if (controller.signal.aborted && streamed.trim()) {
        session.messages.push({ role: 'assistant', text: `${streamed.trim()}\n\n_回答已由用户停止。_`, at: new Date().toISOString() });
      } else {
        const message = controller.signal.aborted ? '回答已停止。' : errorMessage(error);
        session.messages.push({ role: 'error', text: message, at: new Date().toISOString() });
        if (!controller.signal.aborted) this.setStatus(`请求失败：${message}`, true);
      }
    } finally {
      session.updatedAt = new Date().toISOString();
      trimSession(session);
      this.active = undefined;
      this.scheduleSave();
      if (this.noteContext?.file.path === notePath) this.renderMessages();
      this.setBusy(false);
      refs.input.focus();
    }
  }

  private async consume(events: AsyncIterable<AgentEvent>, session: ChatSession, onDelta: (text: string) => void): Promise<string> {
    let final: string | undefined;
    for await (const event of events) {
      if (event.type === 'session') { session.threadId = event.id; this.scheduleSave(); }
      else if (event.type === 'text-delta') onDelta(event.text);
      else if (event.type === 'error') throw new Error(event.message);
      else final = event.text;
    }
    if (final !== undefined) return final;
    throw new Error('智能体没有返回最终回答。');
  }

  private async buildPrompt(context: NoteContext, question: string, attachments: PendingAttachment[], resumed: boolean): Promise<string> {
    const refs = this.refs!;
    const noteText = await this.app.vault.cachedRead(context.file);
    let paper: { pdfPath: string; text: string } | undefined;
    if (context.paper && !resumed) {
      const document = await this.context.store.document(context.paper.sha);
      if (document) paper = { pdfPath: context.paper.pdfPath, text: fullText(document) };
    }
    const outlinks = refs.outlinksInput.checked
      ? await Promise.all(context.outlinks.slice(0, MAX_OUTLINK_NOTES).map(async file => ({ path: file.path, text: await this.app.vault.cachedRead(file) })))
      : [];
    let purpose: string | undefined;
    try { purpose = await this.app.vault.adapter.read(PURPOSE_PATH); } catch { purpose = undefined; }
    return buildChatPrompt({
      notePath: context.file.path, noteText, paper, paperInEarlierTurn: resumed && !!context.paper,
      selection: refs.selectionInput.checked ? context.selection : undefined, outlinks, purpose, attachments, question,
    });
  }

  private async startNewConversation(): Promise<void> {
    const session = this.session();
    if (!session || this.active) return;
    if (session.messages.length && !await confirm(this.app, '开始新对话', '开始新对话会清空浮窗中的当前会话记录。尚未写入笔记的内容将不再显示。是否继续？')) return;
    session.threadId = null;
    session.messages = [];
    session.savedCount = 0;
    session.adapter = this.settings.adapter;
    session.updatedAt = new Date().toISOString();
    this.attachments = [];
    this.renderAttachments();
    this.renderMessages();
    this.scheduleSave();
    this.refs?.input.focus();
  }

  /** Append unsaved turns to `# 提问`; frontmatter (status included) is left as it is. */
  private async writeToNote(): Promise<void> {
    const session = this.session();
    const file = this.noteContext?.file;
    if (!session || !file || this.active) return;
    const unsaved = session.messages.slice(session.savedCount).filter(message => message.role === 'user' || message.role === 'assistant');
    if (!unsaved.length) { new Notice('没有尚未写入的对话内容'); return; }
    try {
      await this.app.vault.process(file, data => insertQuestionAnswerSection(data, unsaved));
      session.savedCount = session.messages.length;
      session.updatedAt = new Date().toISOString();
      this.updateWriteButton();
      this.scheduleSave();
      new Notice('对话已写入当前笔记');
    } catch (error) {
      new Notice(`写入失败：${errorMessage(error)}`);
    }
  }

  private setBusy(busy: boolean): void {
    const refs = this.refs;
    if (!refs) return;
    for (const element of [refs.input, refs.newChatButton, refs.refreshButton, refs.captureButton, refs.attachmentButton, refs.attachmentInput]) element.disabled = busy;
    refs.sendButton.setText(busy ? '停止' : '发送');
    refs.sendButton.setAttribute('aria-label', busy ? '停止当前回答' : '发送问题');
    refs.sendButton.toggleClass('is-stop', busy);
    if (busy) this.setStatus(`${this.settings.adapter === 'claude' ? 'Claude' : 'Codex'} 正在读取资料…（只读）`);
    else if (!refs.status.hasClass('is-error')) this.setStatus('只读模式');
    this.renderAttachments();
    this.updateWriteButton();
  }

  private setStatus(message: string, isError = false): void {
    this.refs?.status.setText(message);
    this.refs?.status.toggleClass('is-error', isError);
  }

  private updateWriteButton(): void {
    const refs = this.refs;
    const session = this.session();
    if (!refs || !session) return;
    const unsaved = session.messages.slice(session.savedCount).some(message => message.role === 'user' || message.role === 'assistant');
    refs.writeButton.disabled = !!this.active || !unsaved;
    refs.writeButton.setText(unsaved ? '写入笔记' : '已保存');
  }

  private scrollToBottom(): void {
    window.requestAnimationFrame(() => { if (this.refs) this.refs.messages.scrollTop = this.refs.messages.scrollHeight; });
  }

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.captureWindowState();
      this.context.saveSettings().catch(error => this.context.log.warn('保存问答状态失败', error));
    }, 250);
  }

  // ---- window geometry ----

  private limits() {
    const maxWidth = Math.max(0, window.innerWidth - PANEL_MARGIN * 2);
    const maxHeight = Math.max(0, window.innerHeight - PANEL_MARGIN * 2);
    return { minWidth: Math.min(PANEL_MIN_WIDTH, maxWidth), minHeight: Math.min(PANEL_MIN_HEIGHT, maxHeight), maxWidth, maxHeight };
  }

  private place(left: number, top: number, width: number, height: number): void {
    this.refs?.panel.setCssStyles({ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  }

  private applyWindowState(): void {
    const saved = this.settings.window;
    const limits = this.limits();
    const width = clamp(saved.width ?? 440, limits.minWidth, limits.maxWidth);
    const height = clamp(saved.height ?? 620, limits.minHeight, limits.maxHeight);
    this.place(saved.left ?? Math.max(PANEL_MARGIN, window.innerWidth - width - 24), saved.top ?? 84, width, height);
    this.constrain();
  }

  private captureWindowState(): void {
    if (!this.refs || !this.visible) return;
    const rect = this.refs.panel.getBoundingClientRect();
    this.settings.window = { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
  }

  private constrain(): void {
    if (!this.refs || !this.visible) return;
    const rect = this.refs.panel.getBoundingClientRect();
    const limits = this.limits();
    const width = clamp(rect.width, limits.minWidth, limits.maxWidth);
    const height = clamp(rect.height, limits.minHeight, limits.maxHeight);
    const left = clamp(rect.left, PANEL_MARGIN, Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN));
    const top = clamp(rect.top, PANEL_MARGIN, Math.max(PANEL_MARGIN, window.innerHeight - height - PANEL_MARGIN));
    this.place(left, top, width, height);
  }

  private startDrag(event: PointerEvent): void {
    if (this.resize || event.button !== 0 || (event.target as HTMLElement | null)?.closest('button, input, textarea') || !this.refs) return;
    const rect = this.refs.panel.getBoundingClientRect();
    this.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top };
    this.refs.panel.addClass('is-dragging');
    event.preventDefault();
  }

  private continueDrag(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointerId || !this.refs) return;
    const rect = this.refs.panel.getBoundingClientRect();
    this.place(this.drag.left + event.clientX - this.drag.startX, this.drag.top + event.clientY - this.drag.startY, rect.width, rect.height);
    this.constrain();
  }

  private stopDrag(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.drag = undefined;
    this.refs?.panel.removeClass('is-dragging');
    this.captureWindowState();
    this.scheduleSave();
  }

  private startResize(event: PointerEvent, handle: HTMLElement): void {
    const direction = handle.dataset.direction;
    if (this.drag || event.button !== 0 || !direction || !this.refs) return;
    const rect = this.refs.panel.getBoundingClientRect();
    this.resize = { pointerId: event.pointerId, direction, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    this.refs.panel.addClass('is-resizing');
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  private continueResize(event: PointerEvent): void {
    const state = this.resize;
    if (!state || event.pointerId !== state.pointerId) return;
    const limits = this.limits();
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    let { left, top, right, bottom } = state;
    if (state.direction.includes('w')) left = clamp(state.left + dx, PANEL_MARGIN, state.right - limits.minWidth);
    if (state.direction.includes('e')) right = clamp(state.right + dx, state.left + limits.minWidth, window.innerWidth - PANEL_MARGIN);
    if (state.direction.includes('n')) top = clamp(state.top + dy, PANEL_MARGIN, state.bottom - limits.minHeight);
    if (state.direction.includes('s')) bottom = clamp(state.bottom + dy, state.top + limits.minHeight, window.innerHeight - PANEL_MARGIN);
    this.place(left, top, right - left, bottom - top);
    event.preventDefault();
  }

  private stopResize(event: PointerEvent): void {
    if (!this.resize || event.pointerId !== this.resize.pointerId) return;
    this.resize = undefined;
    this.refs?.panel.removeClass('is-resizing');
    this.captureWindowState();
    this.scheduleSave();
  }

  private moveWithKeyboard(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !this.refs) return;
    const rect = this.refs.panel.getBoundingClientRect();
    const amount = event.shiftKey ? 40 : 12;
    const left = rect.left + (event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0);
    const top = rect.top + (event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0);
    this.place(left, top, rect.width, rect.height);
    this.constrain();
    this.captureWindowState();
    this.scheduleSave();
    event.preventDefault();
  }
}

/** A fixed, empty working directory: resuming needs the same cwd, and no AGENTS.md/CLAUDE.md is picked up. */
async function chatDirectory(): Promise<string> {
  const dir = path.join(os.tmpdir(), 'paper-workbench-chat');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = parent.createEl('button', { cls: 'clickable-icon pw-chat-icon-button', attr: { type: 'button', title: label, 'aria-label': label } });
  setIcon(button, icon);
  button.addEventListener('click', onClick);
  return button;
}

function checkbox(parent: HTMLElement, text: string, checked: boolean): { input: HTMLInputElement; text: HTMLElement } {
  const label = parent.createEl('label', { cls: 'pw-chat-option' });
  const input = label.createEl('input', { attr: { type: 'checkbox' } });
  input.checked = checked;
  return { input, text: label.createSpan({ cls: 'pw-chat-option-text', text }) };
}

function chip(parent: HTMLElement, icon: string, text: string, warning: boolean): void {
  const element = parent.createSpan({ cls: warning ? 'pw-chat-chip is-warning' : 'pw-chat-chip', attr: { title: text } });
  setIcon(element.createSpan({ cls: 'pw-chat-chip-icon' }), icon);
  element.createSpan({ cls: 'pw-chat-chip-text', text });
}

function summary(attachment: PendingAttachment): AttachmentSummary {
  return { name: attachment.name, type: attachment.type, size: attachment.size, isImage: attachment.isImage };
}

function localPath(file: File): string {
  try { return webUtils.getPathForFile(file); } catch { return ''; }
}

export function linkTarget(value: string): string {
  const text = value.trim();
  const wiki = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(text);
  return (wiki ? wiki[1]! : text).split('#', 1)[0]!.trim();
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '大小未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

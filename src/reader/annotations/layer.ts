import { Component, Keymap, MarkdownRenderer, Notice, Scope } from 'obsidian';
import type { App, TFile } from 'obsidian';
import type { Logger } from '../../core/log';
import { anchorId, parseAnnotations, quoteMatches, writeAnnotation } from './note';
import type { NoteAnnotation } from './note';

/** Marks reader UI inside the reading layer, so search, copy and selection skip it (contracts §6.1). */
const UI = { 'data-pw-ui': '' };

interface Card {
  element: HTMLElement;
  /** The note entry this card shows; differs from the block's anchor after a quote match. */
  entryId?: string;
  /** The note's current text for this entry ('' when there is none). */
  body: string;
  /** The entry's text the open editor started from; a save only replaces the entry while the note still has it. */
  base?: string;
  /** The note changed under the open editor; only an explicit save overwrites it now. */
  conflict?: boolean;
  editor?: HTMLTextAreaElement;
  /** Keys for the open editor; Obsidian's own hotkeys would otherwise take ⌘+Enter first. */
  keys?: Scope;
  saving?: boolean;
  /** The latest text asked to be saved while a write was still running; it is written next. */
  queued?: { value: string; explicit: boolean };
  rendered?: Component;
}

export interface AnnotationOptions {
  app: App;
  root: HTMLElement;
  pdf: TFile;
  sha: string;
  /** English source text of every segment, by sourceHash. */
  segments: ReadonlyMap<string, string>;
  log: Logger;
}

/**
 * Paragraph annotations in the reading layer: one card under each annotated block, read
 * from and written to the paper note's 段落批注 section (src/reader/annotations/note.ts).
 */
export class AnnotationLayer {
  private note: TFile | undefined;
  private readonly cards = new Map<HTMLElement, Card>();
  private readonly component = new Component();
  private orphans: { element: HTMLElement; component: Component } | undefined;
  private disposed = false;

  constructor(private readonly options: AnnotationOptions) {
    this.component.load();
  }

  /** Read the note and place its cards; resolves once they are rendered, so layout is settled. */
  async load(): Promise<void> {
    this.note = findNote(this.options.app, this.options.sha);
    await this.refresh();
  }

  /** The note was changed, created or deleted somewhere; re-read it when it is this paper's. */
  noteChanged(file: TFile): void {
    if (this.disposed || file.extension !== 'md') return;
    if (file === this.note || (!this.note && noteSha(this.options.app, file) === this.options.sha)) {
      if (!this.note) this.note = file;
      void this.refresh();
    }
  }

  /** The block's 批注 tool: open its editor, or explain why there is nowhere to write. */
  edit(block: HTMLElement): void {
    if (!this.note) {
      new Notice('这篇论文还没有笔记。请先生成笔记，再写批注。');
      return;
    }
    const card = this.cards.get(block) ?? this.createCard(block, { body: '' });
    this.openEditor(block, card);
  }

  dispose(): void {
    if (this.disposed) return;
    // Leaving the reader with an editor open keeps what was typed.
    for (const [block, card] of this.cards) {
      if (card.keys) this.options.app.keymap.popScope(card.keys);
      if (!card.editor) continue;
      // A write in flight may still change the note; the latest text, even the original, follows it.
      if (card.saving) { void this.save(block, card, card.editor.value); continue; }
      if (card.editor.value.trim() === card.body) continue;
      if (card.conflict) this.keepDraft(card.editor.value);
      else void this.save(block, card, card.editor.value);
    }
    this.disposed = true;
    for (const card of this.cards.values()) card.rendered?.unload();
    this.component.unload();
  }

  private async refresh(): Promise<void> {
    const { app, sha } = this.options;
    if (this.note && app.vault.getAbstractFileByPath(this.note.path) !== this.note) this.note = findNote(app, sha);
    let text = '';
    try {
      if (this.note) text = await app.vault.cachedRead(this.note);
    } catch (error) {
      this.options.log.warn('读取笔记批注失败', error);
      return;
    }
    if (this.disposed) return;
    await this.place(parseAnnotations(text));
  }

  private async place(entries: NoteAnnotation[]): Promise<void> {
    const placed = new Map<HTMLElement, NoteAnnotation>();
    const orphans: NoteAnnotation[] = [];
    for (const entry of entries) {
      const block = this.blockFor(entry);
      if (block && !placed.has(block)) placed.set(block, entry);
      else orphans.push(entry);
    }
    for (const [block, card] of this.cards) {
      if (placed.has(block)) continue;
      if (card.editor) card.body = '';
      else this.removeCard(block, card);
    }
    const renders: Array<Promise<void>> = [];
    for (const [block, entry] of placed) {
      const card = this.cards.get(block);
      if (card?.editor) { card.entryId = entry.id; card.body = entry.body; continue; }
      if (card && card.body === entry.body && card.entryId === entry.id) continue;
      const target = card ?? this.createCard(block, entry);
      target.entryId = entry.id;
      target.body = entry.body;
      renders.push(this.renderCard(target));
    }
    renders.push(this.renderOrphans(orphans));
    await Promise.all(renders);
  }

  /** By anchor first; then, for a paragraph the parser changed, by the quoted text when unique. */
  private blockFor(entry: NoteAnnotation): HTMLElement | undefined {
    if (entry.broken) return undefined;
    const root = this.options.root;
    const direct = root.querySelector(`[data-segment^="${entry.id}"]`)?.closest<HTMLElement>('.pdf-reader-block');
    if (direct) return direct;
    const matches = [...this.options.segments].filter(([, text]) => quoteMatches(entry.quote, text));
    if (matches.length !== 1) return undefined;
    return root.querySelector(`[data-segment="${matches[0]![0]}"]`)?.closest<HTMLElement>('.pdf-reader-block') ?? undefined;
  }

  private createCard(block: HTMLElement, entry: Partial<NoteAnnotation> & { body: string }): Card {
    const element = block.createDiv({ cls: 'pw-annotation', attr: UI });
    const card: Card = { element, body: entry.body, ...(entry.id ? { entryId: entry.id } : {}) };
    block.addClass('has-annotation');
    element.addEventListener('click', event => {
      // Only the rendered text opens the editor; the editor's own buttons bubble here too.
      const target = event.target as HTMLElement;
      if (card.editor || !target.closest('.pw-annotation-body')) return;
      const link = target.closest('a');
      if (link) { this.followLink(link, event); return; }
      this.openEditor(block, card);
    });
    // Clicking elsewhere saves. Focus moving to this card's own buttons does not, and neither
    // does switching to another window, which leaves the editor as the active element.
    element.addEventListener('focusout', () => {
      const editor = card.editor;
      element.ownerDocument.defaultView?.setTimeout(() => {
        const active = element.ownerDocument.activeElement;
        if (editor && card.editor === editor && !(active && element.contains(active))) void this.save(block, card, editor.value, false);
      }, 0);
    });
    this.cards.set(block, card);
    return card;
  }

  private removeCard(block: HTMLElement, card: Card): void {
    card.rendered?.unload();
    card.element.remove();
    block.removeClass('has-annotation');
    this.cards.delete(block);
  }

  private async renderCard(card: Card): Promise<void> {
    card.rendered?.unload();
    const rendered = new Component();
    card.rendered = rendered;
    rendered.load();
    card.element.empty();
    card.element.removeClass('is-editing');
    const body = card.element.createDiv({ cls: 'pw-annotation-body', attr: { title: '点击编辑' } });
    try {
      await MarkdownRenderer.render(this.options.app, card.body, body, this.note?.path ?? '', rendered);
    } catch (error) {
      this.options.log.warn('批注渲染失败', error);
      body.setText(card.body);
    }
  }

  private openEditor(block: HTMLElement, card: Card): void {
    if (card.editor) { card.editor.focus(); return; }
    card.rendered?.unload();
    card.rendered = undefined;
    card.element.empty();
    card.element.addClass('is-editing');
    block.addClass('has-annotation');
    const editor = card.element.createEl('textarea', { cls: 'pw-annotation-input', attr: { rows: '4', placeholder: '写下你对这一段的理解（Markdown）', 'aria-label': '段落批注' } });
    editor.value = card.body;
    card.editor = editor;
    card.base = card.body;
    card.conflict = false;
    const actions = card.element.createDiv({ cls: 'pw-annotation-actions' });
    actions.createSpan({ cls: 'pw-annotation-hint', text: '⌘/Ctrl+Enter 保存 · Esc 取消 · 清空后保存即删除' });
    const cancel = actions.createEl('button', { type: 'button', text: '取消' });
    const save = actions.createEl('button', { type: 'button', cls: 'mod-cta', text: '保存' });
    const commit = () => void this.save(block, card, editor.value, true);
    cancel.addEventListener('click', () => this.closeEditor(block, card));
    save.addEventListener('click', commit);
    const { app } = this.options;
    const keys = new Scope(app.scope);
    keys.register(['Mod'], 'Enter', () => { commit(); return false; });
    keys.register([], 'Escape', () => { this.closeEditor(block, card); return false; });
    card.keys = keys;
    editor.addEventListener('focus', () => app.keymap.pushScope(keys));
    editor.addEventListener('blur', () => app.keymap.popScope(keys));
    editor.focus();
  }

  private closeEditor(block: HTMLElement, card: Card): void {
    if (card.keys) this.options.app.keymap.popScope(card.keys);
    card.keys = undefined;
    card.editor = undefined;
    if (!card.body) { this.removeCard(block, card); return; }
    void this.renderCard(card);
  }

  /** `explicit` is the save button or ⌘+Enter; leaving the editor never overwrites a conflict. */
  private async save(block: HTMLElement, card: Card, value: string, explicit = false): Promise<void> {
    const editor = card.editor;
    const body = value.trim();
    if (card.saving) { card.queued = { value, explicit: explicit || Boolean(card.queued?.explicit) }; return; }
    if (card.conflict && !explicit) return;
    if (body === card.body) { if (!this.disposed) this.closeEditor(block, card); return; }
    const note = this.note;
    const hash = block.querySelector<HTMLElement>('[data-segment]')?.dataset.segment;
    if (!note || !hash) return;
    // Everything taken from the page is read before the first await; the reader may close meanwhile.
    const { app, pdf, segments } = this.options;
    const page = Number(block.dataset.sourcePages?.split(',')[0]) || 0;
    const link = page ? app.fileManager.generateMarkdownLink(pdf, note.path, `#page=${page}`, `p.${page}`) : app.fileManager.generateMarkdownLink(pdf, note.path);
    const order = this.readingOrder();
    const id = anchorId(hash);
    const replaces = card.entryId && card.entryId !== id ? card.entryId : undefined;
    const base = card.base ?? card.body;
    // The entry's text in the note as it is at write time, when someone else changed it meanwhile.
    let changed: string | undefined;
    card.saving = true;
    try {
      await app.vault.process(note, data => {
        const entries = parseAnnotations(data).filter(entry => !entry.broken);
        const current = (entries.find(entry => entry.id === id) ?? (replaces ? entries.find(entry => entry.id === replaces) : undefined))?.body ?? '';
        changed = current !== base && current !== body ? current : undefined;
        return changed === undefined ? writeAnnotation(data, { anchor: hash, link, text: segments.get(hash) ?? '', body }, id => order.get(id), replaces) : data;
      });
    } catch (error) {
      this.options.log.warn('保存批注失败', error);
      const latest = card.queued?.value ?? value;
      card.queued = undefined;
      // An open editor keeps the text for a retry; once the reader is gone, hand it back.
      new Notice(`保存批注失败：${error instanceof Error ? error.message : String(error)}`);
      if (this.disposed && latest.trim() !== card.body) this.keepDraft(latest, '批注没能写入笔记。');
      return;
    } finally {
      card.saving = false;
    }
    const queued = card.queued;
    card.queued = undefined;
    if (changed !== undefined) {
      if (this.disposed) { this.keepDraft(queued?.value ?? value); return; }
      if (card.editor !== editor || !editor) return;
      card.body = changed;
      card.base = changed;
      card.conflict = true;
      card.element.querySelector('.pw-annotation-hint')?.setText('笔记中的这条已被改动：再次保存会用草稿替换它，取消则保留笔记中的版本');
      new Notice('笔记里的这条批注刚被改动，没有覆盖。草稿还在编辑框里：再次保存会替换笔记中的版本，取消则保留笔记中的版本。');
      return;
    }
    if (card.editor !== editor) return;
    // The note now has this text; anything typed since is checked against it, not the older base.
    card.body = body;
    card.base = body;
    card.entryId = id;
    if (queued) { await this.save(block, card, queued.value, queued.explicit); return; }
    if (this.disposed || editor?.value.trim() !== body) return;
    this.closeEditor(block, card);
  }

  /** The reader is gone and the draft did not reach the note: hand it back. */
  private keepDraft(draft: string, reason = '笔记里的这条批注已被改动，阅读器没有覆盖它。'): void {
    const view = this.options.root.ownerDocument.defaultView;
    const message = createFragment();
    message.createDiv({ text: `${reason}你未保存的草稿：` });
    message.createEl('pre', { cls: 'pw-annotation-draft', text: draft });
    const copy = message.createEl('button', { type: 'button', text: '复制草稿' });
    copy.addEventListener('click', event => {
      event.stopPropagation();
      void view?.navigator.clipboard.writeText(draft);
    });
    new Notice(message, 0);
  }

  /** Each block's anchor id → its place in the reading layer. */
  private readingOrder(): Map<string, number> {
    const order = new Map<string, number>();
    this.options.root.querySelectorAll<HTMLElement>('.pdf-reader-block').forEach((block, index) => {
      const hash = block.querySelector<HTMLElement>('[data-segment]')?.dataset.segment;
      if (hash && !order.has(anchorId(hash))) order.set(anchorId(hash), index);
    });
    return order;
  }

  /** Entries whose paragraph is gone: listed at the end, read-only; the note keeps them. */
  private async renderOrphans(entries: NoteAnnotation[]): Promise<void> {
    this.orphans?.element.remove();
    this.orphans?.component.unload();
    this.orphans = undefined;
    const article = this.options.root.querySelector<HTMLElement>('.pdf-reader-article');
    if (!entries.length || !article) return;
    const panel = article.createDiv({ cls: 'pw-annotation-orphans', attr: UI });
    const component = this.component.addChild(new Component());
    this.orphans = { element: panel, component };
    panel.createEl('h3', { text: `未定位的批注 ${entries.length} 条` });
    panel.createEl('p', { cls: 'pw-annotation-hint', text: '当前解析结果里找不到它们对应的段落，或者 pw: 标记已被改动。内容仍在笔记的「段落批注」一节，可以在那里修改或删除。' });
    await Promise.all(entries.map(async entry => {
      const item = panel.createDiv({ cls: 'pw-annotation' });
      if (entry.quote) item.createEl('blockquote', { text: entry.quote });
      const body = item.createDiv({ cls: 'pw-annotation-body' });
      await MarkdownRenderer.render(this.options.app, entry.body, body, this.note?.path ?? '', component);
    }));
  }

  private followLink(link: HTMLAnchorElement, event: MouseEvent): void {
    if (!link.hasClass('internal-link')) return;
    event.preventDefault();
    const target = link.dataset.href ?? link.getAttribute('href');
    if (target) void this.options.app.workspace.openLinkText(target, this.note?.path ?? '', Keymap.isModEvent(event));
  }
}

/** The paper note: a Markdown file whose frontmatter source_sha256 is this PDF's. */
function findNote(app: App, sha: string): TFile | undefined {
  const notes = app.vault.getMarkdownFiles().filter(file => noteSha(app, file) === sha);
  return notes.find(file => app.metadataCache.getFileCache(file)?.frontmatter?.type === 'paper') ?? notes[0];
}

function noteSha(app: App, file: TFile): string | undefined {
  const value: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.source_sha256;
  return typeof value === 'string' ? value : undefined;
}

export function segmentTexts(blocks: ReadonlyArray<{ text: string; captions?: string[]; footnotes?: string[]; segments?: ReadonlyArray<{ field: string; index: number; sourceHash: string }> }>): Map<string, string> {
  const texts = new Map<string, string>();
  for (const block of blocks) {
    for (const segment of block.segments ?? []) {
      const text = segment.field === 'text' ? block.text : segment.field === 'caption' ? block.captions?.[segment.index] : block.footnotes?.[segment.index];
      if (text) texts.set(segment.sourceHash, text);
    }
  }
  return texts;
}

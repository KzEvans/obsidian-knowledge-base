import { ItemView, Menu, setIcon } from 'obsidian';
import type { ViewStateResult, WorkspaceLeaf } from 'obsidian';
import type { HeaderLeaf } from '../core/obsidian-internal';
import type { LibraryData } from './data';
import { UNFILED, collectionTree, filterPapers, inCollection, sortPapers } from './model';
import type { CollectionNode, Column, NoteState, Paper } from './model';

export const TREE_VIEW = 'paper-workbench-collections';
export const TABLE_VIEW = 'paper-workbench-library';

export interface Workbench {
  data: LibraryData;
  openTable(collection: string | null): Promise<void>;
  /** Replace the table in `leaf` with the paper's note | PDF pair; the PDF pane can return to the table. */
  openPaper(paper: Paper, leaf: WorkspaceLeaf): Promise<void>;
}

const collectionName = (collection: string | null) => collection === null ? '全部文献' : collection === '' ? UNFILED : collection.split('/').pop()!;

/** Sidebar: Zotero collections with paper counts; a click shows the collection in the table. */
export class CollectionTreeView extends ItemView {
  private collapsed = new Set<string>();
  private selected: string | null | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(leaf: WorkspaceLeaf, private readonly workbench: Workbench) { super(leaf); }

  getViewType(): string { return TREE_VIEW; }
  getDisplayText(): string { return '文献库'; }
  override getIcon(): string { return 'library'; }

  override async onOpen(): Promise<void> {
    this.unsubscribe = this.workbench.data.subscribe(() => this.render());
    this.render();
  }

  override async onClose(): Promise<void> { this.unsubscribe?.(); }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass('pw-lib-tree');
    const papers = this.workbench.data.papers;
    this.row(root, { name: '全部文献', path: '', count: papers.length, children: [] }, 0, null);
    for (const node of collectionTree(papers)) this.renderNode(root, node, 0);
  }

  private renderNode(parent: HTMLElement, node: CollectionNode, depth: number): void {
    const item = parent.createDiv({ cls: 'tree-item' });
    this.row(item, node, depth, node.path);
    if (node.children.length && !this.collapsed.has(node.path)) {
      const children = item.createDiv({ cls: 'tree-item-children' });
      for (const child of node.children) this.renderNode(children, child, depth + 1);
    }
  }

  private row(parent: HTMLElement, node: CollectionNode, depth: number, collection: string | null): void {
    const self = parent.createDiv({ cls: 'tree-item-self is-clickable pw-lib-tree-row' });
    self.style.setProperty('--pw-depth', String(depth));
    if (this.selected === collection) self.addClass('is-active');
    const toggle = self.createDiv({ cls: 'tree-item-icon collapse-icon' });
    if (node.children.length) {
      setIcon(toggle, 'right-triangle');
      toggle.toggleClass('is-collapsed', this.collapsed.has(node.path));
      toggle.addEventListener('click', event => {
        event.stopPropagation();
        if (!this.collapsed.delete(node.path)) this.collapsed.add(node.path);
        this.render();
      });
    }
    setIcon(self.createDiv({ cls: 'pw-lib-tree-icon' }), collection === null ? 'library' : collection === '' ? 'inbox' : 'folder');
    self.createDiv({ cls: 'tree-item-inner', text: node.name });
    self.createDiv({ cls: 'tree-item-flair-outer' }).createSpan({ cls: 'tree-item-flair', text: String(node.count) });
    self.addEventListener('click', () => {
      this.selected = collection;
      this.render();
      void this.workbench.openTable(collection);
    });
  }
}

const COLUMNS: Array<{ id: Column; label: string }> = [
  { id: 'title', label: '标题' }, { id: 'author', label: '作者' }, { id: 'year', label: '年份' },
  { id: 'journal', label: '期刊' }, { id: 'impactFactor', label: 'IF' }, { id: 'state', label: '笔记' },
];
const STATES: Array<{ id: NoteState | 'all'; label: string }> = [
  { id: 'all', label: '全部' }, { id: 'none', label: '无笔记' }, { id: 'draft', label: '草稿' }, { id: 'reviewed', label: '已审核' },
];
const STATE_LABEL: Record<NoteState, string> = { none: '无笔记', draft: '草稿', reviewed: '已审核' };

/** Main area: the papers of one collection as a sortable table. A click opens the paper for paired reading. */
export class LibraryTableView extends ItemView {
  private collection: string | null = null;
  private query = '';
  private state: NoteState | 'all' = 'all';
  private sort: { column: Column; descending: boolean } = { column: 'year', descending: true };
  private unsubscribe: (() => void) | undefined;
  private captionEl!: HTMLElement;
  private queryInputEl: HTMLInputElement | undefined;
  private stateButtonsEl!: HTMLElement;
  private rowsEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private readonly workbench: Workbench) { super(leaf); }

  getViewType(): string { return TABLE_VIEW; }
  getDisplayText(): string { return collectionName(this.collection); }
  override getIcon(): string { return 'library'; }

  /** Collection, search, note filter and sort, so returning from a paper restores the same table. */
  override getState(): Record<string, unknown> {
    return { collection: this.collection, query: this.query, noteState: this.state, sort: this.sort };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const saved = (state ?? {}) as { collection?: unknown; query?: unknown; noteState?: unknown; sort?: { column?: unknown; descending?: unknown } };
    this.collection = typeof saved.collection === 'string' ? saved.collection : null;
    this.query = typeof saved.query === 'string' ? saved.query : '';
    this.state = STATES.find(option => option.id === saved.noteState)?.id ?? 'all';
    const column = COLUMNS.find(option => option.id === saved.sort?.column)?.id;
    if (column) this.sort = { column, descending: saved.sort?.descending === true };
    if (this.queryInputEl) this.queryInputEl.value = this.query;
    this.render();
    await super.setState(state, result);
    // Obsidian refreshes the tab title but not the view header when only the state changes.
    (this.leaf as unknown as Partial<HeaderLeaf>).updateHeader?.();
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('pw-lib');
    const bar = root.createDiv({ cls: 'pw-lib-bar' });
    this.captionEl = bar.createDiv({ cls: 'pw-lib-title' });
    const search = this.queryInputEl = bar.createEl('input', { cls: 'pw-lib-search', attr: { type: 'search', placeholder: '搜索标题、作者、期刊、年份' } });
    search.value = this.query;
    search.addEventListener('input', () => { this.query = search.value; this.render(); });
    this.stateButtonsEl = bar.createDiv({ cls: 'pw-lib-states' });
    const table = root.createDiv({ cls: 'pw-lib-scroll' }).createEl('table', { cls: 'pw-lib-table' });
    const head = table.createEl('thead').createEl('tr');
    for (const column of COLUMNS) {
      const th = head.createEl('th', { cls: `pw-col-${column.id}`, text: column.label });
      th.addEventListener('click', () => {
        this.sort = { column: column.id, descending: this.sort.column === column.id ? !this.sort.descending : column.id === 'year' || column.id === 'impactFactor' };
        this.render();
      });
    }
    this.rowsEl = table.createEl('tbody');
    this.unsubscribe = this.workbench.data.subscribe(() => this.render());
    this.render();
  }

  override async onClose(): Promise<void> { this.unsubscribe?.(); }

  private render(): void {
    if (!this.rowsEl) return;
    const all = this.workbench.data.papers.filter(paper => inCollection(paper, this.collection));
    const papers = sortPapers(filterPapers(all, { collection: this.collection, query: this.query, state: this.state }), this.sort.column, this.sort.descending);

    this.captionEl.setText(`${collectionName(this.collection)}（${papers.length}/${all.length}）`);
    this.stateButtonsEl.empty();
    for (const option of STATES) {
      const count = option.id === 'all' ? all.length : all.filter(paper => paper.state === option.id).length;
      const button = this.stateButtonsEl.createEl('button', { text: `${option.label} ${count}` });
      button.toggleClass('is-active', this.state === option.id);
      button.addEventListener('click', () => { this.state = option.id; this.render(); });
    }
    this.contentEl.querySelectorAll('th').forEach((th, index) => {
      const active = COLUMNS[index]?.id === this.sort.column;
      th.toggleClass('is-sorted', active);
      th.dataset.dir = active ? (this.sort.descending ? 'desc' : 'asc') : '';
    });

    this.rowsEl.empty();
    for (const paper of papers) {
      const row = this.rowsEl.createEl('tr');
      row.createEl('td', { cls: 'pw-col-title', text: paper.title, attr: { title: paper.title } });
      row.createEl('td', { text: paper.authors.length > 1 ? `${paper.authors[0]} 等` : paper.authors[0] ?? '', attr: { title: paper.authors.join(', ') } });
      row.createEl('td', { text: paper.year });
      row.createEl('td', { cls: 'pw-col-journal', text: paper.journal, attr: { title: paper.journal } });
      row.createEl('td', { text: paper.impactFactor === null ? '' : String(paper.impactFactor) });
      row.createEl('td').createSpan({ cls: `pw-lib-badge is-${paper.state}`, text: STATE_LABEL[paper.state] });
      row.addEventListener('click', () => void this.workbench.openPaper(paper, this.leaf));
      row.addEventListener('contextmenu', event => {
        if (!paper.zoteroSelect) return;
        const menu = new Menu();
        menu.addItem(item => item.setTitle('在 Zotero 中显示').setIcon('external-link').onClick(() => window.open(paper.zoteroSelect)));
        menu.showAtMouseEvent(event);
      });
    }
    if (!papers.length) this.rowsEl.createEl('tr').createEl('td', { cls: 'pw-lib-empty', text: '没有符合条件的文献', attr: { colspan: String(COLUMNS.length) } });
  }
}

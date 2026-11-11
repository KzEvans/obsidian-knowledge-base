import { Notice } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type { ModuleContext, ModuleHandle } from '../core/module';
import { LibraryData } from './data';
import { Pairing } from './pairing';
import { CollectionTreeView, LibraryTableView, TABLE_VIEW, TREE_VIEW } from './views';
import type { Workbench } from './views';

/** 文献库工作台：侧栏分类、主区文献表、笔记与原文双栏阅读 (docs/architecture.md §6.4) */
export function register(context: ModuleContext<unknown>): ModuleHandle {
  const { app, plugin } = context;
  const data = new LibraryData(app, context.log);
  const pairing = new Pairing(app, path => data.partners(path));
  /** PDF leaves entered from the table, with the table state to return to. */
  const returnTo = new Map<WorkspaceLeaf, Record<string, unknown>>();

  /** From either pane of a paper entered from the table: close the note pane and show the table again. */
  const backToLibrary = async (leaf: WorkspaceLeaf): Promise<boolean> => {
    const pair = pairing.pairOf(leaf);
    const pdf = pair?.pdf ?? leaf;
    const state = returnTo.get(pdf);
    if (!state) return false;
    returnTo.delete(pdf);
    pair?.note.detach();
    await pdf.setViewState({ type: TABLE_VIEW, active: true, state });
    return true;
  };

  const workbench: Workbench = {
    data,
    async openTable(collection) {
      // While reading a paper entered from the table, the table comes back in that place rather than in a parallel tab.
      let leaf = app.workspace.getLeavesOfType(TABLE_VIEW)[0];
      if (!leaf) {
        const attached = new Set<WorkspaceLeaf>();
        app.workspace.iterateRootLeaves(root => { attached.add(root); });
        for (const entered of returnTo.keys()) if (!attached.has(entered)) returnTo.delete(entered);
        leaf = [...returnTo.keys()].at(-1);
        if (leaf) await backToLibrary(leaf);
        else leaf = app.workspace.getLeaf('tab');
      }
      await leaf.setViewState({ type: TABLE_VIEW, active: true, state: { collection } });
      await app.workspace.revealLeaf(leaf);
    },
    async openPaper(paper, leaf) {
      const file = app.vault.getFileByPath(paper.pdfPath) ?? (paper.notePath ? app.vault.getFileByPath(paper.notePath) : null);
      if (!file) { new Notice(`找不到这篇文献的 PDF：${paper.pdfPath}`); return; }
      // The PDF takes the table's place; pairing then opens the note to its left.
      returnTo.set(leaf, leaf.view.getState());
      await leaf.openFile(file, { active: true });
    },
  };

  const openSidebar = async () => {
    const leaf = app.workspace.getLeavesOfType(TREE_VIEW)[0] ?? app.workspace.getLeftLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: TREE_VIEW, active: true });
    await app.workspace.revealLeaf(leaf);
  };

  plugin.registerView(TREE_VIEW, leaf => new CollectionTreeView(leaf, workbench));
  plugin.registerView(TABLE_VIEW, leaf => new LibraryTableView(leaf, workbench));
  plugin.addRibbonIcon('library', '打开文献库', () => void openSidebar());
  plugin.addCommand({ id: 'open-library-sidebar', name: '打开文献库侧栏', callback: () => void openSidebar() });
  plugin.addCommand({ id: 'open-library-table', name: '打开文献库表格', callback: () => void workbench.openTable(null) });
  plugin.addCommand({
    id: 'back-to-library',
    name: '返回文献库',
    checkCallback: checking => {
      const leaf = app.workspace.getMostRecentLeaf();
      const pdf = leaf && (pairing.pairOf(leaf)?.pdf ?? leaf);
      if (!leaf || !pdf || !returnTo.has(pdf)) return false;
      if (!checking) void backToLibrary(leaf);
      return true;
    },
  });
  const removeButton = context.services.pdfToolbar.register({
    id: 'back-to-library', order: 1, icon: 'library', label: '返回文献库',
    onClick: leaf => void backToLibrary(leaf),
    update: (leaf, button) => button.toggle(returnTo.has(leaf)),
  });
  data.start(plugin);
  pairing.start(plugin);

  return { dispose: () => { removeButton(); data.dispose(); } };
}

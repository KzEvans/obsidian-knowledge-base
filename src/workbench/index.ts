import { Notice } from 'obsidian';
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

  const workbench: Workbench = {
    data,
    async openTable(collection) {
      const leaf = app.workspace.getLeavesOfType(TABLE_VIEW)[0] ?? app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: TABLE_VIEW, active: true, state: { collection } });
      await app.workspace.revealLeaf(leaf);
    },
    async openPaper(paper) {
      const file = app.vault.getFileByPath(paper.pdfPath) ?? (paper.notePath ? app.vault.getFileByPath(paper.notePath) : null);
      if (!file) { new Notice(`找不到这篇文献的 PDF：${paper.pdfPath}`); return; }
      await pairing.leafForOpening().openFile(file, { active: true });
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
  data.start(plugin);
  pairing.start(plugin);

  return { dispose: () => data.dispose() };
}

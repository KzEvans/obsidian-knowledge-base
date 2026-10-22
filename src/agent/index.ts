import { Component, MarkdownView, TFile, setIcon } from 'obsidian';
import type { ModuleContext, ModuleHandle } from '../core/module';
import { NoteChat } from './chat/panel';
import { LEGACY_CHAT_DATA, LEGACY_KNOWLEDGE_CONFIG, importLegacySettings, renameSession } from './chat/sessions';
import { NoteController, activeMarkdown, fileOfLeaf } from './notes/controller';
import { createAgentRunner, currentAgent } from './runner';
import { settingsSection } from './settings';
import type { AgentSettings } from './settings';

/** 智能体适配层、笔记生成、笔记问答、状态切换 (docs/architecture.md §5) */
export type { AgentSettings } from './settings';
export { readSettings } from './settings';

interface ViewButtons { chat: HTMLElement; generate: HTMLElement; status: HTMLElement }

export function register(context: ModuleContext<AgentSettings>): ModuleHandle {
  const { app, plugin, settings } = context;
  const component = new Component();
  component.load();
  const notes = new NoteController(context);
  const chat = new NoteChat(context, component);
  context.services.agent = createAgentRunner(() => currentAgent(settings));

  // ---- PDF view / reading mode ----
  const unregisterPdfButton = context.services.pdfToolbar.register({
    id: 'agent-generate-note', order: 30, icon: 'file-pen-line', label: '生成论文笔记',
    onClick: leaf => { const file = fileOfLeaf(leaf); if (file) void notes.generateFor(file); },
  });

  // ---- note header buttons ----
  const buttons = new Map<MarkdownView, ViewButtons>();
  const refreshButtons = () => {
    const views = new Set<MarkdownView>();
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      views.add(view);
      let set = buttons.get(view);
      if (!set) {
        set = {
          chat: view.addAction('message-circle-question', '笔记问答', () => chat.toggle(view)),
          generate: view.addAction('file-pen-line', '重新生成论文笔记', () => { if (view.file) void notes.generateFor(view.file); }),
          status: view.addAction('circle-dashed', '切换审核状态', () => {
            if (notes.isPaperNote(view.file)) void notes.toggleStatus(view.file).then(refreshButtons);
          }),
        };
        for (const element of [set.chat, set.generate, set.status]) element.addClass('pw-note-action');
        buttons.set(view, set);
      }
      const file = view.file;
      const paper = notes.isPaperNote(file);
      set.generate.toggle(paper);
      set.status.toggle(paper);
      if (paper) {
        const reviewed = app.metadataCache.getFileCache(file)?.frontmatter?.status === 'reviewed';
        set.status.empty();
        setIcon(set.status, reviewed ? 'badge-check' : 'circle-dashed');
        set.status.setAttribute('aria-label', reviewed ? '已审核（点击改回草稿）' : '草稿（点击标记为已审核）');
        set.status.toggleClass('is-reviewed', reviewed);
      }
    }
    for (const [view, set] of buttons) {
      if (views.has(view)) continue;
      for (const element of [set.chat, set.generate, set.status]) element.remove();
      buttons.delete(view);
    }
  };
  plugin.registerEvent(app.workspace.on('layout-change', refreshButtons));
  plugin.registerEvent(app.workspace.on('file-open', refreshButtons));
  plugin.registerEvent(app.workspace.on('active-leaf-change', () => { refreshButtons(); chat.onActiveLeafChange(); }));
  plugin.registerEvent(app.metadataCache.on('changed', refreshButtons));
  app.workspace.onLayoutReady(refreshButtons);

  // ---- menus ----
  const isPaperSource = (file: unknown): file is TFile => file instanceof TFile && (file.extension.toLowerCase() === 'pdf' || notes.isPaperNote(file));
  plugin.registerEvent(app.workspace.on('file-menu', (menu, file) => {
    if (!isPaperSource(file)) return;
    menu.addItem(item => item.setTitle('生成论文笔记').setIcon('file-pen-line').onClick(() => void notes.generateFor(file)));
  }));
  plugin.registerEvent(app.workspace.on('files-menu', (menu, files) => {
    const papers = files.filter(isPaperSource);
    if (!papers.length) return;
    menu.addItem(item => item.setTitle(`为选中的论文生成笔记（${papers.length}）`).setIcon('file-pen-line').onClick(() => void notes.generateForMany(papers)));
  }));

  // ---- commands ----
  plugin.addCommand({
    id: 'generate-note', name: '生成当前论文的笔记',
    checkCallback: checking => {
      const file = app.workspace.getActiveFile();
      if (!isPaperSource(file)) return false;
      if (!checking) void notes.generateFor(file);
      return true;
    },
  });
  plugin.addCommand({ id: 'stop-note-generation', name: '停止生成笔记', callback: () => notes.stop() });
  plugin.addCommand({
    id: 'toggle-note-status', name: '切换论文笔记审核状态（draft / reviewed）',
    checkCallback: checking => {
      const file = app.workspace.getActiveFile();
      if (!notes.isPaperNote(file)) return false;
      if (!checking) void notes.toggleStatus(file).then(refreshButtons);
      return true;
    },
  });
  plugin.addCommand({
    id: 'check-note', name: '检查当前笔记',
    checkCallback: checking => {
      const file = app.workspace.getActiveFile();
      if (!(file instanceof TFile) || file.extension !== 'md') return false;
      if (!checking) void notes.checkNote(file);
      return true;
    },
  });
  plugin.addCommand({
    id: 'open-note-chat', name: '打开当前笔记的问答',
    checkCallback: checking => {
      const view = activeMarkdown(app);
      if (!view) return false;
      if (!checking) chat.toggle(view);
      return true;
    },
  });

  // ---- chat sessions follow notes; selection capture ----
  plugin.registerEvent(app.vault.on('rename', (file, oldPath) => {
    if (!(file instanceof TFile)) return;
    if (renameSession(settings, oldPath, file.path)) void context.saveSettings();
    chat.noteRenamed(file);
  }));
  plugin.registerDomEvent(activeDocument, 'selectionchange', () => chat.onSelectionChange());
  plugin.registerDomEvent(window, 'resize', () => chat.onWindowResize());

  if (!settings.legacyImported) app.workspace.onLayoutReady(() => void importLegacy(context));

  return {
    settingsSection: settingsSection(settings, () => context.saveSettings()),
    dispose() {
      unregisterPdfButton();
      notes.dispose();
      chat.dispose();
      for (const set of buttons.values()) for (const element of [set.chat, set.generate, set.status]) element.remove();
      buttons.clear();
      component.unload();
      if (context.services.agent) delete context.services.agent;
    },
  };
}

/** Read codex-note-chat's data.json and system/knowledge/config.json once; neither is modified. */
async function importLegacy(context: ModuleContext<AgentSettings>): Promise<void> {
  const adapter = context.app.vault.adapter;
  const readJson = async (file: string): Promise<unknown> => {
    try { return JSON.parse(await adapter.read(file)) as unknown; } catch { return undefined; }
  };
  try {
    importLegacySettings(context.settings,
      await readJson(`${context.app.vault.configDir}/${LEGACY_CHAT_DATA}`),
      await readJson(LEGACY_KNOWLEDGE_CONFIG));
    await context.saveSettings();
  } catch (error) {
    context.log.warn('导入旧问答设置失败', error);
  }
}

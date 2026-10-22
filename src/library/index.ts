import { Notice, Setting, TFile, requestUrl } from 'obsidian';
import type { TAbstractFile } from 'obsidian';
import path from 'node:path';
import { createCanvasCropper } from '../core/crop-canvas';
import { obsidianHttp } from '../core/http';
import { createMinerUClient } from '../core/mineru';
import type { LibraryContext, ModuleHandle } from '../core/module';
import { openPdf } from '../core/pdf';
import { atomicWrite } from '../core/store';
import type { Manifest } from '../core/types';
import { createVaultFiles } from './files';
import { hasReaderCache, importLegacyState, importReaderCache, readJson } from './migration';
import { Pipeline } from './pipeline/pipeline';
import { ENRICH_INTERVAL_MS, STARTUP_ENRICH_DELAY_MS, STARTUP_SYNC_DELAY_MS, SYNC_INTERVAL_MS, Scheduler } from './scheduler';
import { applyLegacyConfig, readSettings, supportingSettings } from './settings';
import type { LibrarySettings } from './settings';
import { BacklogModal, PipelinePanel, statusText } from './ui';
import { createZoteroApi } from './zotero/api';
import { runEnrichment } from './zotero/enrich';
import type { EnrichmentState } from './zotero/impact-factor';
import { applyNoteMoves, isPrimaryPaperNote, metadataUpdates, noteAttachment, planNoteMoves } from './zotero/notes';
import type { PaperNote } from './zotero/notes';
import { createSiClient } from './zotero/supporting';
import { PDF_DIR, syncZotero } from './zotero/sync';
import type { SyncEntry, SyncState } from './zotero/sync';

export type { LibrarySettings } from './settings';
export { readSettings } from './settings';

const STATE_FILE = 'state.json';
const ENRICHMENT_FILE = 'enrichment-cache.json';
const LEGACY_SYNC_DIR = 'system/zotero-sync';

export function isLibraryPdf(vaultPath: string): boolean {
  return vaultPath.startsWith(`${PDF_DIR}/`) && vaultPath.toLowerCase().endsWith('.pdf');
}

/** Zotero sync, SI / impact-factor enrichment, the parse/translate pipeline and legacy cache import (architecture §4). */
export function register(context: LibraryContext<LibrarySettings>): ModuleHandle {
  const { app, plugin, settings, log, events } = context;
  const http = obsidianHttp(requestUrl);
  const adapter = app.vault.adapter;
  const statePath = path.join(context.pluginDir, STATE_FILE);
  const enrichmentPath = path.join(context.pluginDir, ENRICHMENT_FILE);

  const renameInVault = async (from: string, to: string) => {
    const file = app.vault.getAbstractFileByPath(from);
    const folder = to.slice(0, to.lastIndexOf('/'));
    if (folder && !await adapter.exists(folder)) await adapter.mkdir(folder);
    if (file instanceof TFile) await app.fileManager.renameFile(file, to);
    else await adapter.rename(from, to);
  };
  const files = createVaultFiles(context.vaultPath, renameInVault);
  const zotero = createZoteroApi(http, () => settings.zoteroApi);

  const isApproved = (manifest: Manifest) => {
    if (manifest.sources.length && manifest.sources.every(source => !source.inLibrary)) return true;
    if (settings.backlog.decision === 'confirmed') return true;
    return settings.backlog.decision === 'deferred' && !settings.backlog.deferred.includes(manifest.sha256);
  };

  const pipeline = new Pipeline({
    store: context.store,
    events,
    mineru: createMinerUClient(http, () => context.secrets.get('mineru')),
    qwenMt: context.qwenMt,
    glossary: () => context.core.glossary,
    readPdf: async vaultPath => new Uint8Array(await adapter.readBinary(vaultPath)),
    openPdf,
    createCropper: pdf => createCanvasCropper(pdf, () => createEl('canvas'), 2 * Math.min(window.devicePixelRatio, 2)),
    isApproved,
    isInLibrary: isLibraryPdf,
    hasLegacyCache: sha => hasReaderCache(path.join(context.vaultPath, app.vault.configDir, 'plugins', 'pdf-reading-mode', 'cache'), sha),
    log,
  });
  context.services.pipeline = pipeline;
  if (settings.pipelinePaused) pipeline.pause();

  // ---- status bar ----
  const statusItem = plugin.addStatusBarItem();
  statusItem.addClass('pw-library-status', 'mod-clickable');
  let statusTimer: number | undefined;
  const scheduler = new Scheduler({
    sync: () => runSync(),
    enrich: () => runEnrich(),
    events,
    notify: message => new Notice(message),
    onStatus: () => renderStatus(),
    log,
  });
  const renderStatus = () => {
    if (statusTimer !== undefined) return;
    statusTimer = window.setTimeout(() => {
      statusTimer = undefined;
      statusItem.setText(statusText(scheduler.status, pipeline.snapshot(), pipeline.paused));
      statusItem.setAttribute('aria-label', scheduler.status.message ?? '点击打开流水线面板');
    }, 100);
  };
  const setPaused = async (paused: boolean) => {
    if (paused) pipeline.pause(); else pipeline.resume();
    settings.pipelinePaused = paused;
    await context.saveSettings();
  };
  const openPanel = () => new PipelinePanel(app, pipeline, events, setPaused).open();
  plugin.registerDomEvent(statusItem, 'click', openPanel);
  for (const name of ['paper:stage-changed', 'paper:translation-progress', 'paper:conflict', 'pipeline:paused', 'zotero:sync-finished'] as const) {
    plugin.register(events.on(name, renderStatus));
  }
  plugin.register(events.on('paper:conflict', ({ files: conflicts }) => new Notice(`iCloud 冲突副本：${conflicts.join('、')}。这篇论文已暂停处理，请在流水线面板里确认保留哪个版本。`, 12_000)));

  // ---- persisted sync state (plugin folder, device-local) ----
  const loadState = async () => await readJson(statePath) as SyncState | undefined ?? null;
  const loadEnrichment = async (): Promise<{ state: EnrichmentState; missing: boolean }> => {
    const saved = await readJson(enrichmentPath) as Partial<EnrichmentState> | undefined;
    return { state: { ...saved, impact_factor_cache: saved?.impact_factor_cache ?? {} }, missing: saved === undefined };
  };
  const writeJson = (file: string, value: unknown) => atomicWrite(file, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'));

  async function runSync() {
    const enrichment = await loadEnrichment();
    const result = await syncZotero({
      api: zotero, files, collectionName: settings.collectionName, collectionKey: settings.collectionKey,
      catalog: settings.impactFactors, state: await loadState(), enrichment: enrichment.state,
      saveState: state => writeJson(statePath, state), log: message => log.info(message),
    });
    if (result.collectionKey !== settings.collectionKey) { settings.collectionKey = result.collectionKey; await context.saveSettings(); }
    await followNotes(result.entries);
    // The vault watcher also reports these; telling the pipeline directly does not depend on it.
    for (const copied of result.copiedPaths) await pipeline.discover(copied);
    for (const entry of result.entries) {
      if (entry.active) await pipeline.describeSource(entry.destination, { zoteroAttachmentKey: entry.attachment_key, zoteroParentKey: entry.parent_key });
    }
    return result;
  }

  async function followNotes(entries: readonly SyncEntry[]) {
    const notes: Array<PaperNote & { file: TFile }> = app.vault.getMarkdownFiles()
      .filter(file => isPrimaryPaperNote(file.path))
      .map(file => ({ file, path: file.path, frontmatter: app.metadataCache.getFileCache(file)?.frontmatter }));
    const { conflicts } = await applyNoteMoves(planNoteMoves(notes, entries), {
      exists: target => app.vault.getAbstractFileByPath(target) !== null,
      rename: renameInVault,
      log: message => log.warn(message),
    });
    if (conflicts.length) new Notice(`有 ${conflicts.length} 篇笔记没有随分类移动，因为目标位置已有同名笔记：${conflicts[0]}`, 10_000);
    const byKey = new Map(entries.map(entry => [entry.attachment_key, entry]));
    for (const note of notes) {
      const entry = byKey.get(noteAttachment(note) ?? '');
      const updates = entry && metadataUpdates(note.frontmatter, entry);
      if (!updates) continue;
      try { await app.fileManager.processFrontMatter(note.file, frontmatter => { Object.assign(frontmatter, updates); }); }
      catch (error) { log.warn(`影响因子回填失败：${note.file.path}`, error); }
    }
  }

  async function runEnrich() {
    const enrichment = await loadEnrichment();
    await runEnrichment({
      api: zotero, collectionName: settings.collectionName, collectionKey: settings.collectionKey,
      enrichment: enrichment.state, enrichmentMissing: enrichment.missing,
      saveEnrichment: state => writeJson(enrichmentPath, state),
      impactFactor: { settings: settings.automaticImpactFactor, catalog: settings.impactFactors, http, agent: context.services.agent },
      supporting: { settings: supportingSettings(settings.supportingInformation), files, client: createSiClient(http, settings.supportingInformation.timeoutSeconds * 1000) },
      log: message => log.info(message),
    });
  }

  // ---- backlog confirmation ----
  let backlogOpen = false;
  async function askBacklog(force: boolean) {
    if (backlogOpen) return;
    const items = await pipeline.backlog();
    if (!items.length) {
      if (settings.backlog.decision === null) { settings.backlog = { decision: 'confirmed', deferred: [] }; await context.saveSettings(); }
      if (force) new Notice('没有等待补跑的论文。');
      return;
    }
    backlogOpen = true;
    new BacklogModal(app, items, confirmed => {
      backlogOpen = false;
      if (confirmed === null) return;
      settings.backlog = confirmed
        ? { decision: 'confirmed', deferred: [] }
        : { decision: 'deferred', deferred: [...new Set([...settings.backlog.deferred, ...items.map(item => item.sha)])] };
      void context.saveSettings().then(() => pipeline.kickAll());
    }).open();
  }

  // ---- startup ----
  let disposed = false;
  const startup = async () => {
    if (!settings.legacyImported) {
      const config = await readJson(path.join(context.vaultPath, LEGACY_SYNC_DIR, 'config.json')).catch(() => undefined);
      if (config) applyLegacyConfig(settings, config);
      const copied = await importLegacyState(path.join(context.vaultPath, LEGACY_SYNC_DIR), context.pluginDir, [STATE_FILE, ENRICHMENT_FILE]);
      if (copied.length) log.info(`已导入旧同步状态：${copied.join('、')}`);
      settings.legacyImported = true;
      await context.saveSettings();
    }
    const imported = await importReaderCache(path.join(context.vaultPath, app.vault.configDir, 'plugins', 'pdf-reading-mode', 'cache'), context.store, undefined, message => log.info(message));
    for (const error of imported.errors) log.warn(`旧阅读缓存暂未导入（可能仍在从 iCloud 下载，下次启动再试）：${error}`);
    if (disposed) return;
    await pipeline.start();
    await pipeline.pruneIndex(vaultPath => app.vault.getAbstractFileByPath(vaultPath) !== null);
    const indexed = await context.store.paths();
    for (const file of app.vault.getFiles()) {
      if (disposed) return;
      if (isLibraryPdf(file.path) && !indexed[file.path]) await pipeline.discover(file.path);
    }
    renderStatus();
    if (settings.backlog.decision === null) await askBacklog(false);
  };

  const onFile = (handler: (file: TFile) => void) => (file: TAbstractFile) => { if (file instanceof TFile && file.extension.toLowerCase() === 'pdf') handler(file); };
  app.workspace.onLayoutReady(() => {
    if (disposed) return;
    plugin.registerEvent(app.vault.on('create', onFile(file => { if (isLibraryPdf(file.path)) void pipeline.discover(file.path); })));
    plugin.registerEvent(app.vault.on('modify', onFile(file => {
      void context.store.paths().then(paths => { if (paths[file.path] || isLibraryPdf(file.path)) return pipeline.discover(file.path); });
    })));
    plugin.registerEvent(app.vault.on('rename', (file, oldPath) => { if (file instanceof TFile && file.extension.toLowerCase() === 'pdf') void pipeline.onRename(oldPath, file.path); }));
    plugin.registerEvent(app.vault.on('delete', onFile(file => { void pipeline.onDelete(file.path); })));
    void startup().catch(error => log.error('文献库启动失败', error));
    plugin.registerInterval(window.setTimeout(() => { void scheduler.sync(false); }, STARTUP_SYNC_DELAY_MS));
    plugin.registerInterval(window.setTimeout(() => { void scheduler.enrich(); }, STARTUP_ENRICH_DELAY_MS));
  });
  plugin.registerInterval(window.setInterval(() => { void scheduler.sync(false); }, SYNC_INTERVAL_MS));
  plugin.registerInterval(window.setInterval(() => { void scheduler.enrich(); }, ENRICH_INTERVAL_MS));

  plugin.addCommand({ id: 'zotero-sync', name: '立即同步 Zotero', callback: () => { void scheduler.sync(true); } });
  plugin.addCommand({ id: 'pipeline-panel', name: '打开流水线面板', callback: openPanel });
  plugin.addCommand({ id: 'pipeline-pause', name: '暂停或继续流水线', callback: () => { void setPaused(!pipeline.paused); } });
  plugin.addCommand({ id: 'pipeline-backlog', name: '补跑文献库存量论文', callback: () => { void askBacklog(true); } });
  plugin.addRibbonIcon('refresh-cw', '同步 Zotero', () => { void scheduler.sync(true); });

  return {
    settingsSection: {
      title: '文献库',
      render(container) {
        new Setting(container).setName('Zotero 本地 API 地址').setDesc('Zotero 7 需开启“允许此计算机上的其他应用程序与 Zotero 通信”。')
          .addText(text => text.setValue(settings.zoteroApi).onChange(async value => { settings.zoteroApi = value.trim() || readSettings({}).zoteroApi; await context.saveSettings(); }));
        new Setting(container).setName('同步的 Zotero 分类').setDesc('包含它的全部子分类。PDF 镜像到 sources/literature/pdf/<分类路径>/。')
          .addText(text => text.setValue(settings.collectionName).onChange(async value => { settings.collectionName = value.trim() || 'Doc'; settings.collectionKey = ''; await context.saveSettings(); }))
          .addButton(button => button.setButtonText('立即同步').onClick(() => { void scheduler.sync(true); }));
        new Setting(container).setName('暂停流水线').setDesc('暂停后正在进行的步骤会做完，不再开始新的上传、解析或翻译。')
          .addToggle(toggle => toggle.setValue(pipeline.paused).onChange(value => setPaused(value)));
        new Setting(container).setName('存量补跑').setDesc(settings.backlog.decision === 'confirmed' ? '已确认处理全部存量论文。' : '列出尚未处理的存量论文和预计 MinerU 页数，确认后开始。')
          .addButton(button => button.setButtonText('查看并补跑').onClick(() => { void askBacklog(true); }));
        new Setting(container).setName('Supporting Information').setDesc('每小时从 Zotero 子附件、Figshare 和出版社页面查找 SI，缓存到 sources/literature/si/。')
          .addToggle(toggle => toggle.setValue(settings.supportingInformation.enabled).onChange(async value => { settings.supportingInformation.enabled = value; await context.saveSettings(); }));
        new Setting(container).setName('影响因子自动查询').setDesc('Zotero Extra 和本地表都没有时，通过智能体联网核实官方来源；智能体模块未加载时跳过。')
          .addToggle(toggle => toggle.setValue(settings.automaticImpactFactor.enabled).onChange(async value => { settings.automaticImpactFactor.enabled = value; await context.saveSettings(); }));
        new Setting(container).setName('每轮最多查询期刊数')
          .addSlider(slider => slider.setLimits(1, 10, 1).setValue(settings.automaticImpactFactor.maxJournalsPerRun).onChange(async value => { settings.automaticImpactFactor.maxJournalsPerRun = value; await context.saveSettings(); }));
        new Setting(container).setName('本地影响因子表').setDesc('JSON：键为期刊全名、缩写或 ISSN，值为 {"impact_factor": 5.5, "year": "2024", "source": "…"}。')
          .addTextArea(area => {
            area.inputEl.rows = 5;
            area.setValue(JSON.stringify(settings.impactFactors, null, 2)).onChange(async value => {
              try {
                const parsed = JSON.parse(value || '{}') as unknown;
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
                settings.impactFactors = parsed as Record<string, unknown>;
                await context.saveSettings();
              } catch { /* keep the last valid table while typing */ }
            });
          });
      },
    },
    dispose() {
      disposed = true;
      if (statusTimer !== undefined) window.clearTimeout(statusTimer);
      pipeline.dispose();
      if (context.services.pipeline === pipeline) delete context.services.pipeline;
    },
  };
}

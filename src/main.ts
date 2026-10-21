import { FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';
import type { App } from 'obsidian';
import path from 'node:path';
import { EventBus } from './core/events';
import { obsidianHttp } from './core/http';
import { createLogger } from './core/log';
import type { ModuleContext, ModuleHandle, SettingsSection } from './core/module';
import { createPdfToolbar } from './core/pdf-toolbar';
import { createQwenMtClient } from './core/qwen-mt';
import { createSecretAccess, importLegacySecrets } from './core/secrets';
import type { Services } from './core/services';
import { coreSettingsSection, readCoreSettings } from './core/settings';
import type { CoreSettings } from './core/settings';
import { FileStore } from './core/store';
import * as library from './library';
import * as agent from './agent';
import * as reader from './reader';
import * as selection from './reader/selection';

/** data.json: one namespace per module (architecture §7). Secrets never live here. */
interface PluginData {
  core: CoreSettings;
  library: library.LibrarySettings;
  agent: agent.AgentSettings;
  reader: reader.ReaderSettings;
  selection: selection.SelectionSettings;
}

export default class PaperWorkbenchPlugin extends Plugin {
  private data!: PluginData;
  private handles: ModuleHandle[] = [];
  private sections: SettingsSection[] = [];
  private events = new EventBus();

  override async onload(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('Paper Workbench 需要桌面版 Obsidian。');
    const vaultPath = adapter.getBasePath();
    const pluginDir = path.join(vaultPath, this.manifest.dir ?? path.join(this.app.vault.configDir, 'plugins', this.manifest.id));

    const saved = (await this.loadData() ?? {}) as Partial<Record<keyof PluginData, unknown>>;
    this.data = {
      core: readCoreSettings(saved.core),
      library: library.readSettings(saved.library),
      agent: agent.readSettings(saved.agent),
      reader: reader.readSettings(saved.reader),
      selection: selection.readSettings(saved.selection),
    };

    const copied = importLegacySecrets(this.app);
    if (copied.length) new Notice('已从旧插件导入密钥。MinerU Token 曾在对话中出现过，请到 MinerU 后台更换后重新保存。', 12_000);

    const secrets = createSecretAccess(this.app);
    const http = obsidianHttp(requestUrl);
    const qwenMt = createQwenMtClient(http, () => secrets.get('dashscope'), () => this.data.core.qwenMtEndpoint);
    const store = new FileStore({
      basePath: vaultPath,
      resourcePath: relative => adapter.getResourcePath(relative),
      readVaultFile: vaultRelative => adapter.readBinary(vaultRelative),
    });
    const services: Services = { pdfToolbar: createPdfToolbar(this.app, this) };
    const save = () => this.saveData(this.data);
    const context = <S>(scope: string, settings: S): ModuleContext<S> => ({
      app: this.app, plugin: this, events: this.events, services, store, settings, saveSettings: save,
      core: this.data.core, secrets, qwenMt, log: createLogger(scope), vaultPath, pluginDir,
    });

    this.sections.push(coreSettingsSection(this.data.core, save, secrets, qwenMt));
    // Only library receives the store writer.
    this.handles.push(library.register({ ...context('library', this.data.library), store }));
    this.handles.push(agent.register(context('agent', this.data.agent)));
    this.handles.push(reader.register(context('reader', this.data.reader)));
    this.handles.push(selection.register(context('selection', this.data.selection)));
    for (const handle of this.handles) if (handle.settingsSection) this.sections.push(handle.settingsSection);

    this.addSettingTab(new WorkbenchSettingTab(this.app, this, this.sections));
  }

  override onunload(): void {
    for (const handle of this.handles.reverse()) {
      try { handle.dispose?.(); }
      catch (error) { createLogger('main').error('模块卸载失败', error); }
    }
    this.handles = [];
    this.events.clear();
  }
}

class WorkbenchSettingTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin, private readonly sections: readonly SettingsSection[]) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    for (const section of this.sections) {
      new Setting(containerEl).setName(section.title).setHeading();
      section.render(containerEl.createDiv());
    }
  }
}

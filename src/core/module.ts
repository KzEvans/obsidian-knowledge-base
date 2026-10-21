import type { App, Plugin } from 'obsidian';
import type { EventBus } from './events';
import type { Logger } from './log';
import type { QwenMtClient } from './qwen-mt';
import type { SecretAccess } from './secrets';
import type { Services } from './services';
import type { StoreReader, StoreWriter } from './store';
import type { CoreSettings } from './settings';

/** One settings group in the shared settings tab (architecture §7). */
export interface SettingsSection {
  title: string;
  render(container: HTMLElement): void;
}

/** What register() returns to main.ts. */
export interface ModuleHandle {
  settingsSection?: SettingsSection;
  dispose?(): void;
}

/** Everything a module may use. Only library's context carries a StoreWriter (see main.ts). */
export interface ModuleContext<S, Store extends StoreReader = StoreReader> {
  app: App;
  plugin: Plugin;
  events: EventBus;
  services: Services;
  store: Store;
  /** This module's own slice of data.json; mutate it, then call saveSettings(). */
  settings: S;
  saveSettings(): Promise<void>;
  /** Read-only view of the shared service settings (glossary, endpoints). */
  core: Readonly<CoreSettings>;
  secrets: SecretAccess;
  qwenMt: QwenMtClient;
  log: Logger;
  /** Absolute vault path; the plugin is desktop-only. */
  vaultPath: string;
  /** This plugin's folder, for device-local files such as diagnostics. */
  pluginDir: string;
}

export type LibraryContext<S> = ModuleContext<S, StoreWriter>;

export type RegisterModule<S> = (context: ModuleContext<S>) => ModuleHandle;

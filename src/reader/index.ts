import type { ModuleContext, ModuleHandle } from '../core/module';
import { ReaderController } from './controller';
import { importLegacySettings, readerSettingsSection } from './settings';
import type { ReaderSettings } from './settings';

/** 阅读模式与中英对照 (docs/architecture.md §6) */
export type { ReaderSettings } from './settings';
export { readSettings } from './settings';

const LEGACY_PLUGIN = 'pdf-reading-mode';

export function register(context: ModuleContext<ReaderSettings>): ModuleHandle {
  const controller = new ReaderController(context);
  controller.start();
  if (!context.settings.legacyImported) {
    context.app.workspace.onLayoutReady(() => void importLegacy(context, () => controller.refreshTypography()));
  }
  return {
    settingsSection: readerSettingsSection(context.settings, () => context.saveSettings(), () => controller.refreshTypography()),
    dispose: () => controller.dispose(),
  };
}

/** One-time import of the old pdf-reading-mode settings; its data.json is only read. */
async function importLegacy(context: ModuleContext<ReaderSettings>, onTypography: () => void): Promise<void> {
  const file = `${context.app.vault.configDir}/plugins/${LEGACY_PLUGIN}/data.json`;
  try {
    const adapter = context.app.vault.adapter;
    const legacy: unknown = await adapter.exists(file) ? JSON.parse(await adapter.read(file)) : {};
    const { positions } = await importLegacySettings(context.settings, legacy, vaultPath => context.store.shaForPath(vaultPath));
    await context.saveSettings();
    onTypography();
    if (positions) context.log.info(`已从旧阅读模式导入 ${positions} 篇的阅读位置`);
  } catch (error) {
    context.log.warn('导入旧阅读模式设置失败', error);
  }
}

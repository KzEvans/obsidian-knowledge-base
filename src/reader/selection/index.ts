import type { ModuleContext, ModuleHandle } from '../../core/module';
import { importLegacySettings, selectionSettingsSection } from './settings';
import type { SelectionSettings } from './settings';
import { SelectionTranslator } from './translator';

/** 划线翻译 (docs/architecture.md §6.3) */
export type { SelectionSettings } from './settings';
export { readSettings } from './settings';

export function register(context: ModuleContext<SelectionSettings>): ModuleHandle {
  const translator = new SelectionTranslator(context);
  translator.start();

  void importLegacySettings(context.app.vault.adapter, context.app.vault.configDir, context.settings)
    .then(changed => changed ? context.saveSettings() : undefined)
    .catch((error: unknown) => context.log.warn('导入旧划线翻译设置失败', error));

  return {
    settingsSection: selectionSettingsSection(context.settings, () => context.saveSettings()),
    dispose: () => translator.dispose(),
  };
}

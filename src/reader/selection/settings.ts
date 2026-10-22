import { Setting } from 'obsidian';
import type { DataAdapter } from 'obsidian';
import { SELECTION_MODEL } from '../../core/qwen-mt';
import type { SettingsSection } from '../../core/module';

export interface SelectionSettings {
  maxSelectionCharacters: number;
  timeoutSeconds: number;
  /** The old plugin's data.json is read once; afterwards these settings are the only source. */
  legacyImported: boolean;
}

const CHARACTERS = { min: 1_000, max: 20_000, fallback: 8_000 };
const TIMEOUT = { min: 5, max: 120, fallback: 30 };

export function readSettings(saved: unknown): SelectionSettings {
  const value = (typeof saved === 'object' && saved !== null ? saved : {}) as Partial<Record<keyof SelectionSettings, unknown>>;
  return {
    maxSelectionCharacters: clampInt(value.maxSelectionCharacters, CHARACTERS),
    timeoutSeconds: clampInt(value.timeoutSeconds, TIMEOUT),
    legacyImported: value.legacyImported === true,
  };
}

/** Copy the character limit and timeout from pdf-selection-translator's data.json, once. Returns whether settings changed. */
export async function importLegacySettings(adapter: Pick<DataAdapter, 'exists' | 'read'>, configDir: string, settings: SelectionSettings): Promise<boolean> {
  if (settings.legacyImported) return false;
  const file = `${configDir}/plugins/pdf-selection-translator/data.json`;
  if (await adapter.exists(file)) {
    // A read or parse failure leaves the flag unset, so the import is tried again next load.
    const legacy = JSON.parse(await adapter.read(file)) as Record<string, unknown> | null;
    if (typeof legacy?.maxSelectionCharacters === 'number') settings.maxSelectionCharacters = clampInt(legacy.maxSelectionCharacters, CHARACTERS);
    if (typeof legacy?.timeoutSeconds === 'number') settings.timeoutSeconds = clampInt(legacy.timeoutSeconds, TIMEOUT);
  }
  settings.legacyImported = true;
  return true;
}

export function selectionSettingsSection(settings: SelectionSettings, save: () => Promise<void>): SettingsSection {
  return {
    title: '划线翻译',
    render(container) {
      container.createDiv({
        cls: 'setting-item-description pw-selection-settings-note',
        text: `在 PDF 标签页右上角点击语言图标为该标签页开启。之后选中的文本（只发送选中的文字）会经 ${SELECTION_MODEL} 翻译成中文，弹窗出现在选区旁，Esc 关闭。API Key、接口地址和术语表在“服务与密钥”中设置。`,
      });
      numberSetting(container, '单次选择字符上限', '防止误选整篇文档造成高延迟和过多用量（1,000–20,000）。', CHARACTERS, 500,
        () => settings.maxSelectionCharacters, value => { settings.maxSelectionCharacters = value; });
      numberSetting(container, '翻译超时（秒）', '等待 Qwen-MT 完成单次翻译的最长时间（5–120 秒）。', TIMEOUT, 5,
        () => settings.timeoutSeconds, value => { settings.timeoutSeconds = value; });

      function numberSetting(parent: HTMLElement, name: string, description: string, range: typeof CHARACTERS, step: number, get: () => number, set: (value: number) => void): void {
        new Setting(parent).setName(name).setDesc(description).addText(text => {
          text.inputEl.type = 'number';
          text.inputEl.min = String(range.min);
          text.inputEl.max = String(range.max);
          text.inputEl.step = String(step);
          text.setValue(String(get())).onChange(async value => {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isFinite(parsed)) return;
            set(clampInt(parsed, range));
            await save();
          });
        });
      }
    },
  };
}

function clampInt(value: unknown, range: typeof CHARACTERS): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return range.fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

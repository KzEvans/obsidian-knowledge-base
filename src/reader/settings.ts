import { Setting } from 'obsidian';
import type { SettingsSection } from '../core/module';

export interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  scrollDiagnostics: boolean;
  /** Last source page per PDF sha256, so renaming or moving a PDF keeps it. */
  positions: Record<string, number>;
  /** Whether the old pdf-reading-mode data.json has been read once. */
  legacyImported: boolean;
}

export const FONT_SIZE = { min: 16, max: 24, default: 18 } as const;
export const LINE_HEIGHT = { min: 1.3, max: 1.8, default: 1.5 } as const;
const SHA = /^[0-9a-f]{64}$/;

export function readSettings(saved: unknown): ReaderSettings {
  const value = (typeof saved === 'object' && saved !== null ? saved : {}) as Partial<Record<keyof ReaderSettings, unknown>>;
  const positions: Record<string, number> = {};
  if (typeof value.positions === 'object' && value.positions !== null) {
    for (const [sha, page] of Object.entries(value.positions as Record<string, unknown>)) {
      if (SHA.test(sha) && typeof page === 'number' && Number.isInteger(page) && page > 0) positions[sha] = page;
    }
  }
  return {
    fontSize: clampNumber(value.fontSize, FONT_SIZE.min, FONT_SIZE.max, FONT_SIZE.default),
    lineHeight: clampNumber(value.lineHeight, LINE_HEIGHT.min, LINE_HEIGHT.max, LINE_HEIGHT.default),
    scrollDiagnostics: value.scrollDiagnostics === true,
    positions,
    legacyImported: value.legacyImported === true,
  };
}

/**
 * Take typography, diagnostics and reading positions from the old plugin's data.json.
 * Positions there are keyed by vault path; they are re-keyed by sha through the
 * store's path index, hashing only paths the index does not know. Positions
 * already recorded here win.
 */
export async function importLegacySettings(settings: ReaderSettings, legacy: unknown, index: Readonly<Record<string, string>>, shaForPath: (path: string) => Promise<string | undefined>): Promise<{ positions: number }> {
  const old = (typeof legacy === 'object' && legacy !== null ? legacy : {}) as Record<string, unknown>;
  if (typeof old.fontSize === 'number') settings.fontSize = clampNumber(old.fontSize, FONT_SIZE.min, FONT_SIZE.max, settings.fontSize);
  if (typeof old.lineHeight === 'number') settings.lineHeight = clampNumber(old.lineHeight, LINE_HEIGHT.min, LINE_HEIGHT.max, settings.lineHeight);
  if (typeof old.scrollDiagnostics === 'boolean') settings.scrollDiagnostics = old.scrollDiagnostics;
  let positions = 0;
  if (typeof old.positions === 'object' && old.positions !== null) {
    for (const [path, page] of Object.entries(old.positions as Record<string, unknown>)) {
      if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) continue;
      let sha = index[path];
      if (!sha) {
        try { sha = await shaForPath(path); } catch { continue; }
      }
      if (!sha || sha in settings.positions) continue;
      settings.positions[sha] = page;
      positions++;
    }
  }
  settings.legacyImported = true;
  return { positions };
}

export function readerSettingsSection(settings: ReaderSettings, save: () => Promise<void>, onTypography: () => void): SettingsSection {
  return {
    title: '阅读',
    render(container) {
      new Setting(container).setName('正文字号').setDesc('单栏阅读模式的英文字号；中文按首次渲染时测得的比例统一缩放。')
        .addSlider(slider => slider.setLimits(FONT_SIZE.min, FONT_SIZE.max, 1).setValue(settings.fontSize).onChange(async value => {
          settings.fontSize = value;
          onTypography();
          await save();
        }));
      new Setting(container).setName('正文行距')
        .addSlider(slider => slider.setLimits(LINE_HEIGHT.min, LINE_HEIGHT.max, 0.05).setValue(settings.lineHeight).onChange(async value => {
          settings.lineHeight = value;
          onTypography();
          await save();
        }));
      new Setting(container).setName('滚动性能诊断').setDesc('排查卡顿时开启：在插件目录的 diagnostics/ 下记录打开耗时和滚动帧间隔，不含正文，不上传。下次开启阅读模式时生效。')
        .addToggle(toggle => toggle.setValue(settings.scrollDiagnostics).onChange(async value => {
          settings.scrollDiagnostics = value;
          await save();
        }));
    },
  };
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

import { Notice, Setting } from 'obsidian';
import type { SecretAccess, SecretName } from './secrets';
import { DEFAULT_QWEN_MT_ENDPOINT, SELECTION_MODEL } from './qwen-mt';
import type { QwenMtClient } from './qwen-mt';
import type { SettingsSection } from './module';
import type { Term } from './types';

export interface CoreSettings {
  qwenMtEndpoint: string;
  glossary: Term[];
}

export const DEFAULT_CORE_SETTINGS: CoreSettings = {
  qwenMtEndpoint: DEFAULT_QWEN_MT_ENDPOINT,
  glossary: [],
};

/** Keep only well-formed fields from data.json; anything unknown falls back to the default. */
export function readCoreSettings(saved: unknown): CoreSettings {
  const value = (typeof saved === 'object' && saved !== null ? saved : {}) as Partial<Record<keyof CoreSettings, unknown>>;
  return {
    qwenMtEndpoint: typeof value.qwenMtEndpoint === 'string' && value.qwenMtEndpoint.trim() ? value.qwenMtEndpoint.trim() : DEFAULT_CORE_SETTINGS.qwenMtEndpoint,
    glossary: Array.isArray(value.glossary)
      ? value.glossary.filter((term): term is Term => typeof (term as Term)?.source === 'string' && typeof (term as Term)?.target === 'string')
      : [],
  };
}

/** One term per line: `source = target`. */
export function parseGlossary(text: string): Term[] {
  return text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).flatMap(line => {
    const match = /^(.+?)\s*=\s*(.+)$/.exec(line);
    return match ? [{ source: match[1]!.trim(), target: match[2]!.trim() }] : [];
  });
}

export function formatGlossary(terms: readonly Term[]): string {
  return terms.map(term => `${term.source} = ${term.target}`).join('\n');
}

export function coreSettingsSection(settings: CoreSettings, save: () => Promise<void>, secrets: SecretAccess, qwenMt: QwenMtClient): SettingsSection {
  return {
    title: '服务与密钥',
    render(container) {
      secretSetting(container, secrets, 'mineru', 'MinerU Token', 'MinerU 精准解析 API Token。只保存在 Obsidian 安全存储中。');
      secretSetting(container, secrets, 'dashscope', '阿里云百炼 API Key', '用于 Qwen-MT 全文翻译和划线翻译。只保存在 Obsidian 安全存储中。');

      new Setting(container).setName('Qwen-MT 接口地址').setDesc('与 API Key 属于同一地域。以 /compatible-mode/v1 或 /chat/completions 结尾。')
        .addText(text => text.setPlaceholder(DEFAULT_QWEN_MT_ENDPOINT).setValue(settings.qwenMtEndpoint).onChange(async value => {
          settings.qwenMtEndpoint = value.trim() || DEFAULT_QWEN_MT_ENDPOINT;
          await save();
        }))
        .addButton(button => button.setButtonText('测试连接').onClick(async () => {
          button.setDisabled(true);
          const started = performance.now();
          try {
            const result = await qwenMt.translate({ text: 'Dielectric elastomer actuator.', model: SELECTION_MODEL, terms: [], timeoutMs: 20_000 });
            new Notice(`连接成功（${Math.round(performance.now() - started)} ms）：${result}`);
          } catch (error) {
            new Notice(`连接失败：${error instanceof Error ? error.message : String(error)}`);
          } finally {
            button.setDisabled(false);
          }
        }));

      new Setting(container).setName('术语表').setDesc('每行一条：英文 = 中文。全文翻译和划线翻译都会使用；修改后只重译用到改动术语的段落。')
        .addTextArea(area => {
          area.inputEl.rows = 8;
          area.setPlaceholder('dielectric elastomer = 介电弹性体').setValue(formatGlossary(settings.glossary)).onChange(async value => {
            settings.glossary = parseGlossary(value);
            await save();
          });
        });
    },
  };
}

function secretSetting(container: HTMLElement, secrets: SecretAccess, name: SecretName, label: string, description: string): void {
  let pending = '';
  const setting = new Setting(container).setName(label)
    .setDesc(`${description}${secrets.get(name) ? '（已保存）' : '（未保存）'}`);
  setting.addText(text => {
    text.inputEl.type = 'password';
    text.inputEl.autocomplete = 'off';
    text.setPlaceholder('粘贴后点击保存').onChange(value => { pending = value; });
  });
  setting.addButton(button => button.setButtonText('保存').setCta().onClick(() => {
    if (!pending.trim()) { new Notice(`请输入${label}。`); return; }
    secrets.set(name, pending);
    pending = '';
    setting.setDesc(`${description}（已保存）`);
    setting.controlEl.querySelector('input')?.setAttribute('value', '');
    new Notice(`${label}已保存到安全存储。`);
  }));
}

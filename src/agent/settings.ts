import { Setting } from 'obsidian';
import type { SettingsSection } from '../core/module';
import type { AdapterName } from './cli/adapter';
import { probeDirs } from './cli/environment';

export interface AttachmentSummary { name: string; type: string; size: number; isImage: boolean }

export interface ChatMessage {
  role: 'user' | 'assistant' | 'error';
  text: string;
  attachments?: AttachmentSummary[];
  at: string;
}

export interface ChatSession {
  /** The CLI that owns `threadId`; a session from the other CLI cannot be resumed. */
  adapter: AdapterName;
  threadId: string | null;
  messages: ChatMessage[];
  /** Messages before this index are already written to the note. */
  savedCount: number;
  updatedAt: string;
}

export interface WindowState { left?: number; top?: number; width?: number; height?: number }

export interface AgentSettings {
  adapter: AdapterName;
  codexPath: string;
  claudePath: string;
  codexModel: string;
  claudeModel: string;
  proxyUrl: string;
  generationTimeoutMinutes: number;
  includeSelection: boolean;
  includeOutlinks: boolean;
  contextCollapsed: boolean;
  window: WindowState;
  /** Keyed by note path; follows renames. */
  sessions: Record<string, ChatSession>;
  /** codex-note-chat and system/knowledge/config.json were read once. */
  legacyImported: boolean;
}

export const DEFAULT_TIMEOUT_MINUTES = 30;

export function readSettings(saved: unknown): AgentSettings {
  const value = record(saved);
  const text = (key: string) => typeof value[key] === 'string' ? (value[key] as string).trim() : '';
  const flag = (key: string) => value[key] === true;
  const minutes = Number(value.generationTimeoutMinutes);
  return {
    adapter: value.adapter === 'claude' ? 'claude' : 'codex',
    codexPath: text('codexPath'),
    claudePath: text('claudePath'),
    codexModel: text('codexModel'),
    claudeModel: text('claudeModel'),
    proxyUrl: text('proxyUrl'),
    generationTimeoutMinutes: Number.isFinite(minutes) && minutes >= 1 ? Math.min(Math.round(minutes), 240) : DEFAULT_TIMEOUT_MINUTES,
    includeSelection: flag('includeSelection'),
    includeOutlinks: flag('includeOutlinks'),
    contextCollapsed: flag('contextCollapsed'),
    window: readWindow(value.window),
    sessions: readSessions(value.sessions, 'codex'),
    legacyImported: flag('legacyImported'),
  };
}

export function readWindow(saved: unknown): WindowState {
  const value = record(saved);
  const result: WindowState = {};
  for (const key of ['left', 'top', 'width', 'height'] as const) {
    const number = value[key];
    if (typeof number === 'number' && Number.isFinite(number)) result[key] = number;
  }
  return result;
}

/** Also reads codex-note-chat's sessions, whose thread ids belong to Codex. */
export function readSessions(saved: unknown, fallbackAdapter: AdapterName): Record<string, ChatSession> {
  const sessions: Record<string, ChatSession> = {};
  for (const [notePath, raw] of Object.entries(record(saved))) {
    const session = record(raw);
    const messages = (Array.isArray(session.messages) ? session.messages : []).flatMap((item): ChatMessage[] => {
      const message = record(item);
      if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'error') return [];
      return [{
        role: message.role,
        text: typeof message.text === 'string' ? message.text : '',
        attachments: Array.isArray(message.attachments) ? message.attachments.flatMap(readAttachment) : undefined,
        at: typeof message.at === 'string' ? message.at : '',
      }];
    });
    const savedCount = Number(session.savedCount);
    sessions[notePath] = {
      adapter: session.adapter === 'claude' || session.adapter === 'codex' ? session.adapter : fallbackAdapter,
      threadId: typeof session.threadId === 'string' && session.threadId ? session.threadId : null,
      messages,
      savedCount: Number.isFinite(savedCount) ? Math.max(0, Math.min(Math.floor(savedCount), messages.length)) : 0,
      updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : '',
    };
  }
  return sessions;
}

function readAttachment(raw: unknown): AttachmentSummary[] {
  const value = record(raw);
  if (typeof value.name !== 'string' || !value.name) return [];
  return [{ name: value.name, type: typeof value.type === 'string' ? value.type : '', size: Number(value.size) || 0, isImage: value.isImage === true }];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function settingsSection(settings: AgentSettings, save: () => Promise<void>): SettingsSection {
  return {
    title: '智能体',
    render(container) {
      new Setting(container).setName('默认智能体').setDesc('生成笔记、笔记问答和影响因子查询使用的命令行工具。切换后，已有问答会话无法续接，会新开一轮。')
        .addDropdown(dropdown => dropdown.addOption('codex', 'Codex').addOption('claude', 'Claude Code').setValue(settings.adapter).onChange(async value => {
          settings.adapter = value === 'claude' ? 'claude' : 'codex';
          await save();
        }));
      const probe = probeDirs().join('、');
      textSetting(container, 'Codex 路径', `留空时依次查找 ${probe}。`, '自动探测', settings.codexPath, value => { settings.codexPath = value; }, save);
      textSetting(container, 'Codex 模型', '留空使用 Codex 默认模型。', '默认', settings.codexModel, value => { settings.codexModel = value; }, save);
      textSetting(container, 'Claude Code 路径', `留空时依次查找 ${probe}。`, '自动探测', settings.claudePath, value => { settings.claudePath = value; }, save);
      textSetting(container, 'Claude Code 模型', '留空使用 Claude Code 默认模型，也可填 opus、sonnet 等别名。', '默认', settings.claudeModel, value => { settings.claudeModel = value; }, save);
      textSetting(container, '代理地址', '设置后注入 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY；localhost 不走代理。', 'http://127.0.0.1:7890', settings.proxyUrl, value => { settings.proxyUrl = value; }, save);
      new Setting(container).setName('生成超时（分钟）').setDesc('单篇笔记生成超过这个时间就停止，整个进程组一起结束。')
        .addText(text => text.setPlaceholder(String(DEFAULT_TIMEOUT_MINUTES)).setValue(String(settings.generationTimeoutMinutes)).onChange(async value => {
          const minutes = Number(value);
          settings.generationTimeoutMinutes = Number.isFinite(minutes) && minutes >= 1 ? Math.min(Math.round(minutes), 240) : DEFAULT_TIMEOUT_MINUTES;
          await save();
        }));
    },
  };
}

function textSetting(container: HTMLElement, name: string, description: string, placeholder: string, value: string, assign: (value: string) => void, save: () => Promise<void>): void {
  new Setting(container).setName(name).setDesc(description)
    .addText(text => text.setPlaceholder(placeholder).setValue(value).onChange(async next => {
      assign(next.trim());
      await save();
    }));
}

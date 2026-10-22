import type { AgentSettings, ChatSession } from '../settings';
import { readSessions, readWindow } from '../settings';

export const MAX_STORED_MESSAGES = 80;
export const LEGACY_CHAT_DATA = 'plugins/codex-note-chat/data.json';
export const LEGACY_KNOWLEDGE_CONFIG = 'system/knowledge/config.json';

export function sessionFor(settings: AgentSettings, notePath: string): ChatSession {
  let session = settings.sessions[notePath];
  if (!session) {
    session = { adapter: settings.adapter, threadId: null, messages: [], savedCount: 0, updatedAt: new Date().toISOString() };
    settings.sessions[notePath] = session;
  }
  return session;
}

export function trimSession(session: ChatSession): void {
  const removed = session.messages.length - MAX_STORED_MESSAGES;
  if (removed <= 0) return;
  session.messages.splice(0, removed);
  session.savedCount = Math.max(0, session.savedCount - removed);
}

/** Sessions follow their note when it is renamed or moved. */
export function renameSession(settings: AgentSettings, oldPath: string, newPath: string): boolean {
  const session = settings.sessions[oldPath];
  if (!session || oldPath === newPath) return false;
  settings.sessions[newPath] = session;
  delete settings.sessions[oldPath];
  return true;
}

/**
 * One-time import from codex-note-chat's data.json and system/knowledge/config.json
 * (docs/migration.md §2.5). Existing values in this plugin always win; the old files are only read.
 */
export function importLegacySettings(settings: AgentSettings, chatData: unknown, knowledgeConfig: unknown): void {
  const chat = record(chatData);
  for (const [notePath, session] of Object.entries(readSessions(chat.sessions, 'codex'))) {
    settings.sessions[notePath] ??= session;
  }
  if (typeof chat.includeSelection === 'boolean') settings.includeSelection ||= chat.includeSelection;
  if (typeof chat.includeOutlinks === 'boolean') settings.includeOutlinks ||= chat.includeOutlinks;
  if (typeof chat.contextCollapsed === 'boolean') settings.contextCollapsed ||= chat.contextCollapsed;
  if (!Object.keys(settings.window).length) settings.window = readWindow(chat.window);
  const config = record(knowledgeConfig);
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  settings.codexPath ||= text(config.codex_path);
  settings.proxyUrl ||= text(config.proxy_url);
  settings.codexModel ||= text(config.forge_model);
  settings.legacyImported = true;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

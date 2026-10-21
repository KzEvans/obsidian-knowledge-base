import type { ModuleContext, ModuleHandle } from '../core/module';

/** 智能体适配层、笔记生成、笔记问答 (docs/architecture.md §5) */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled in by the agent session
export interface AgentSettings {}

export function readSettings(_saved: unknown): AgentSettings {
  return {};
}

export function register(_context: ModuleContext<AgentSettings>): ModuleHandle {
  return {};
}

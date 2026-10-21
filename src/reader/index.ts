import type { ModuleContext, ModuleHandle } from '../core/module';

/** 阅读模式与中英对照 (docs/architecture.md §6) */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled in by the reader session
export interface ReaderSettings {}

export function readSettings(_saved: unknown): ReaderSettings {
  return {};
}

export function register(_context: ModuleContext<ReaderSettings>): ModuleHandle {
  return {};
}

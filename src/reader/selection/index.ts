import type { ModuleContext, ModuleHandle } from '../../core/module';

/** 划线翻译 (docs/architecture.md §6.3) */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled in by the selection session
export interface SelectionSettings {}

export function readSettings(_saved: unknown): SelectionSettings {
  return {};
}

export function register(_context: ModuleContext<SelectionSettings>): ModuleHandle {
  return {};
}

import type { LibraryContext, ModuleHandle } from '../core/module';

/** Zotero sync, the parse/translate pipeline and legacy cache import (docs/architecture.md §4). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled in by the library session
export interface LibrarySettings {}

export function readSettings(_saved: unknown): LibrarySettings {
  return {};
}

export function register(_context: LibraryContext<LibrarySettings>): ModuleHandle {
  return {};
}

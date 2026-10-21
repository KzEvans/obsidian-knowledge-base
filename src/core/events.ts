import type { Stage, StageFailure } from './types';

/** Every cross-module notification (docs/contracts.md §6). Payloads are hints: subscribers re-read the store. */
export interface EventMap {
  'paper:stage-changed': { sha: string; stage: Stage; failure?: StageFailure };
  'paper:parse-progress': { sha: string; done: number; total: number };
  'paper:translation-progress': { sha: string; done: number; total: number; failed: number };
  'paper:document-updated': { sha: string; normalizerVersion: number };
  'paper:conflict': { sha: string; files: string[] };
  'paper:path-changed': { sha: string; oldPath: string; newPath: string };
  'pipeline:paused': { paused: boolean };
  'zotero:sync-finished': { ok: boolean; copied: number; failed: number; error?: string };
  'reader:mode-change': { leafId: string; active: boolean; language: 'en' | 'zh' };
  'note:generated': { notePath: string; sha: string; conflict: boolean };
}

export type EventName = keyof EventMap;
type Listener<K extends EventName> = (payload: EventMap[K]) => void;

export class EventBus {
  private listeners = new Map<EventName, Set<Listener<EventName>>>();

  /** Returns the unsubscribe function. */
  on<K extends EventName>(name: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(name);
    if (!set) { set = new Set(); this.listeners.set(name, set); }
    set.add(listener as Listener<EventName>);
    return () => { set.delete(listener as Listener<EventName>); };
  }

  /** A failing listener is reported but never stops the others or the emitter. */
  emit<K extends EventName>(name: K, payload: EventMap[K]): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      try { listener(payload); }
      catch (error) { console.error(`[paper-workbench] ${name} listener failed`, error); }
    }
  }

  clear(): void { this.listeners.clear(); }
}

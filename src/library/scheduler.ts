import type { EventBus } from '../core/events';
import { errorMessage } from '../core/secrets';

export const SYNC_INTERVAL_MS = 3 * 60 * 60 * 1000;
export const ENRICH_INTERVAL_MS = 60 * 60 * 1000;
export const STARTUP_SYNC_DELAY_MS = 3_000;
export const STARTUP_ENRICH_DELAY_MS = 10_000;

export interface SyncStatus { state: 'idle' | 'running' | 'ok' | 'failed'; at?: Date; message?: string }

export interface SchedulerDeps {
  sync(): Promise<{ copied: number; failed: number; errors: string[] }>;
  enrich(): Promise<void>;
  events: EventBus;
  notify(message: string): void;
  onStatus(status: SyncStatus): void;
  log: { warn(message: string, error?: unknown): void };
}

/**
 * Sync and enrichment each own a busy flag; neither waits for the other or for the pipeline.
 * An overlapping trigger is dropped, never queued; a failure is shown in the status bar and retried next round.
 */
export class Scheduler {
  private syncing = false;
  private enriching = false;
  status: SyncStatus = { state: 'idle' };

  constructor(private readonly deps: SchedulerDeps) {}

  get syncBusy(): boolean { return this.syncing; }

  /** Returns false when a sync was already running. Manual runs report through a notice. */
  async sync(manual: boolean): Promise<boolean> {
    if (this.syncing) {
      if (manual) this.deps.notify('Zotero 同步正在运行，请稍后再试。');
      return false;
    }
    this.syncing = true;
    this.setStatus({ state: 'running' });
    if (manual) this.deps.notify('Zotero 同步已开始。');
    try {
      const result = await this.deps.sync();
      const message = result.failed ? `${result.failed} 项失败：${result.errors[0] ?? ''}` : undefined;
      this.setStatus({ state: result.failed ? 'failed' : 'ok', at: new Date(), ...(message ? { message } : {}) });
      this.deps.events.emit('zotero:sync-finished', { ok: result.failed === 0, copied: result.copied, failed: result.failed, ...(message ? { error: message } : {}) });
      if (manual) this.deps.notify(result.failed ? `Zotero 同步完成，${message}` : `Zotero 同步已完成，复制 ${result.copied} 篇。`);
    } catch (error) {
      const message = errorMessage(error);
      this.deps.log.warn('Zotero 同步失败，下一轮重试', error);
      this.setStatus({ state: 'failed', at: new Date(), message });
      this.deps.events.emit('zotero:sync-finished', { ok: false, copied: 0, failed: 0, error: message });
      if (manual) this.deps.notify(`Zotero 同步失败：${message}`);
    } finally {
      this.syncing = false;
    }
    return true;
  }

  async enrich(): Promise<boolean> {
    if (this.enriching) return false;
    this.enriching = true;
    try { await this.deps.enrich(); }
    catch (error) { this.deps.log.warn('SI / 影响因子补全推迟', error); }
    finally { this.enriching = false; }
    return true;
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    this.deps.onStatus(status);
  }
}

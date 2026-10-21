/** A bounded-concurrency executor with priority, pause and per-key cancellation (architecture §3.5). */

export class CancelledError extends Error {
  constructor(message = '任务已取消。') { super(message); this.name = 'AbortError'; }
}

interface Job<T> {
  key: string;
  priority: boolean;
  run: (signal: AbortSignal) => Promise<T>;
  controller: AbortController;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export class TaskQueue {
  private waiting: Job<unknown>[] = [];
  private running = new Map<string, Job<unknown>>();
  private pausedState = false;

  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('并发数必须是正整数。');
  }

  get paused(): boolean { return this.pausedState; }
  get size(): number { return this.waiting.length + this.running.size; }
  has(key: string): boolean { return this.running.has(key) || this.waiting.some(job => job.key === key); }

  /** A key that is already queued or running joins nothing: the caller gets an error, so duplicates are explicit. */
  enqueue<T>(key: string, run: (signal: AbortSignal) => Promise<T>, options: { priority?: boolean } = {}): Promise<T> {
    if (this.has(key)) return Promise.reject(new Error(`任务已在队列中：${key}`));
    return new Promise<T>((resolve, reject) => {
      const job: Job<T> = { key, priority: options.priority === true, run, controller: new AbortController(), resolve, reject };
      this.insert(job as Job<unknown>);
      this.pump();
    });
  }

  /** Move a waiting job to the front of the line. Running jobs are unaffected. */
  prioritize(key: string): void {
    const index = this.waiting.findIndex(job => job.key === key);
    if (index < 0) return;
    const [job] = this.waiting.splice(index, 1);
    job!.priority = true;
    this.insert(job!);
  }

  cancel(key: string): void {
    const index = this.waiting.findIndex(job => job.key === key);
    if (index >= 0) {
      const [job] = this.waiting.splice(index, 1);
      job!.reject(new CancelledError());
      return;
    }
    this.running.get(key)?.controller.abort(new CancelledError());
  }

  /** Running jobs finish; nothing new starts until resume(). */
  pause(): void { this.pausedState = true; }
  resume(): void { this.pausedState = false; this.pump(); }

  /** Abort everything, e.g. on plugin unload. */
  clear(): void {
    for (const job of this.waiting.splice(0)) job.reject(new CancelledError());
    for (const job of this.running.values()) job.controller.abort(new CancelledError());
  }

  private insert(job: Job<unknown>): void {
    if (!job.priority) { this.waiting.push(job); return; }
    const firstOrdinary = this.waiting.findIndex(waiting => !waiting.priority);
    this.waiting.splice(firstOrdinary < 0 ? this.waiting.length : firstOrdinary, 0, job);
  }

  private pump(): void {
    while (!this.pausedState && this.running.size < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.running.set(job.key, job);
      void this.execute(job);
    }
  }

  private async execute(job: Job<unknown>): Promise<void> {
    try {
      job.resolve(await job.run(job.controller.signal));
    } catch (error) {
      job.reject(job.controller.signal.aborted && !(error instanceof CancelledError) ? new CancelledError() : error);
    } finally {
      this.running.delete(job.key);
      this.pump();
    }
  }
}

export const RETRY_DELAYS_MS = [2_000, 8_000, 30_000, 120_000, 600_000] as const;

export interface RetryOptions {
  delays?: readonly number[];
  signal?: AbortSignal;
  /** Errors that cannot succeed on retry (bad credentials, quota) fail at once. */
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Run with exponential backoff. Rethrows the last error with `attempts` attached. */
export async function withRetry<T>(run: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const delays = options.delays ?? RETRY_DELAYS_MS;
  const sleep = options.sleep ?? abortableSleep;
  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) throw new CancelledError();
    try {
      return await run(attempt);
    } catch (error) {
      const delay = delays[attempt - 1];
      if (error instanceof CancelledError || options.signal?.aborted || delay === undefined || options.isRetryable?.(error) === false) {
        throw attachAttempts(error, attempt);
      }
      options.onRetry?.(attempt, error, delay);
      await sleep(delay, options.signal);
    }
  }
}

export function attemptsOf(error: unknown): number {
  return typeof (error as { attempts?: unknown } | undefined)?.attempts === 'number' ? (error as { attempts: number }).attempts : 1;
}

function attachAttempts(error: unknown, attempts: number): unknown {
  if (error instanceof Error) Object.assign(error, { attempts });
  return error;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new CancelledError()); return; }
    const timer = window.setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { window.clearTimeout(timer); reject(new CancelledError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

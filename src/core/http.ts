import type { RequestUrlParam } from 'obsidian';

/** The subset of Obsidian's requestUrl response the clients read. Injected so clients can be tested in Node. */
export interface HttpResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  text: string;
  arrayBuffer: ArrayBuffer;
  json: unknown;
}

export type Http = (request: RequestUrlParam) => Promise<HttpResponse>;

/** Wrap obsidian.requestUrl; a body that is not JSON reads as undefined instead of throwing. */
export function obsidianHttp(requestUrl: (request: RequestUrlParam) => Promise<{ status: number; headers: Record<string, string>; text: string; arrayBuffer: ArrayBuffer; json: unknown }>): Http {
  return async request => {
    const response = await requestUrl({ ...request, throw: false });
    let json: unknown;
    try { json = response.json; } catch { json = undefined; }
    const headers = Object.fromEntries(Object.entries(response.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    return { status: response.status, headers, text: response.text, arrayBuffer: response.arrayBuffer, json };
  };
}

/** Reject after `timeoutMs` or on abort; requestUrl itself cannot be cancelled, so its result is ignored. */
export function raceWithTimeout<T>(request: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, timeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const timer = window.setTimeout(() => finish(() => reject(new Error(timeoutMessage))), timeoutMs);
    const onAbort = () => finish(() => reject(abortError()));
    signal?.addEventListener('abort', onAbort, { once: true });
    request.then(value => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))));
  });
}

export function abortError(): Error {
  const error = new Error('请求已取消。');
  error.name = 'AbortError';
  return error;
}

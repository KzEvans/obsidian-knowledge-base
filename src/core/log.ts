import { redact } from './secrets';

export interface Logger {
  info(message: string): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

/** Console logging that always passes text through redact(). */
export function createLogger(scope: string): Logger {
  const prefix = `[paper-workbench:${scope}]`;
  const detail = (error: unknown) => error === undefined ? '' : ' ' + redact(describe(error));
  return {
    info: message => console.debug(prefix, redact(message)),
    warn: (message, error) => console.warn(prefix, redact(message) + detail(error)),
    error: (message, error) => console.error(prefix, redact(message) + detail(error)),
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error) ?? typeof error; } catch { return typeof error; }
}

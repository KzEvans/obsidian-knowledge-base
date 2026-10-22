import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
}

export class ProcessError extends Error {
  constructor(message: string, readonly kind: 'timeout' | 'cancelled' | 'exit' | 'spawn', readonly stderr = '') { super(message); }
}

const KILL_GRACE_MS = 2000;
const STDERR_TAIL = 4000;

/**
 * Run a CLI in its own process group and yield its stdout line by line.
 * Cancel and timeout end the whole group (grandchildren included); so does a normal exit,
 * so nothing a CLI started outlives it.
 */
export async function* runLines(request: ProcessRequest, signal: AbortSignal): AsyncGenerator<string> {
  if (signal.aborted) throw new ProcessError('已取消。', 'cancelled');
  const child = spawn(request.command, request.args, {
    cwd: request.cwd, env: request.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  let stopped: ProcessError | undefined;
  let spawnError: Error | undefined;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_TAIL); });
  child.on('error', error => { spawnError = error; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.on('close', (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });

  let killTimer = 0;
  const stop = (reason: ProcessError) => {
    if (stopped) return;
    stopped = reason;
    killGroup(child.pid, 'SIGTERM');
    killTimer = window.setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
  };
  const onAbort = () => stop(new ProcessError('已取消。', 'cancelled'));
  signal.addEventListener('abort', onAbort);
  const timeout = window.setTimeout(() => stop(new ProcessError(`超过 ${Math.round(request.timeoutMs / 1000)} 秒未完成，已停止。`, 'timeout')), request.timeoutMs);

  child.stdin.on('error', () => undefined);
  child.stdin.end(request.stdin);
  try {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (stopped) break;
      if (line.trim()) yield line;
    }
    const exit = await exited;
    if (stopped) throw stopped;
    if (spawnError) throw new ProcessError(`无法启动 ${request.command}：${spawnError.message}`, 'spawn');
    if (exit.code !== 0) {
      throw new ProcessError(`${lastLine(stderr) || '进程异常退出'}（退出码 ${exit.code ?? exit.signal ?? '未知'}）`, 'exit', stderr);
    }
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
    // Also ends the group when the consumer stops iterating early or the CLI left children behind.
    stop(new ProcessError('已结束。', 'cancelled'));
    await exited;
    window.clearTimeout(killTimer);
    killGroup(child.pid, 'SIGKILL');
  }
}

function killGroup(pid: number | undefined, killSignal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, killSignal); }
  catch { /* the group is already gone */ }
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1)?.trim() ?? '';
}

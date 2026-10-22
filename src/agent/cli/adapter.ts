import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childEnv, resolveCli } from './environment';
import { ProcessError, runLines } from './process';

export type AdapterName = 'codex' | 'claude';

export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];

/** One CLI turn (docs/architecture.md §5.1). */
export interface AgentRequest {
  prompt: string;
  /** Passed as developer/system instructions, not as part of the user turn. */
  instructions?: string;
  cwd: string;
  /** Extra directories the agent may read (Claude needs them listed; Codex reads the disk read-only). */
  readableDirs?: string[];
  /** Directories besides cwd the agent may write; only in write-workspace mode. */
  writableDirs?: string[];
  images?: string[];
  resumeId?: string;
  model?: string;
  /** Codex only; omitted to use the selected model's default. */
  reasoningEffort?: CodexReasoningEffort;
  timeoutMs: number;
  mode: 'read-only' | 'write-workspace';
  webSearch?: boolean;
  outputSchema?: object;
  /** Do not keep the session on disk; it cannot be resumed. */
  ephemeral?: boolean;
}

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'session'; id: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

export interface AgentAdapter {
  readonly name: AdapterName;
  run(request: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

/** What each CLI contributes: argv, stdin and a JSONL parser. */
export interface CliDialect {
  name: AdapterName;
  binary: string;
  build(request: AgentRequest, files: { schemaFile?: string }): { args: string[]; stdin: string };
  parser(): (event: unknown) => AgentEvent[];
}

export interface AdapterOptions {
  cliPath: () => string;
  proxyUrl: () => string;
  env?: NodeJS.ProcessEnv;
}

/** Errors from the CLI arrive as events; only a missing final answer is turned into one here. */
export function createAdapter(dialect: CliDialect, options: AdapterOptions): AgentAdapter {
  return {
    name: dialect.name,
    async *run(request, signal) {
      let tempDir: string | undefined;
      let final: Extract<AgentEvent, { type: 'done' }> | undefined;
      let lastError: string | undefined;
      try {
        const command = resolveCli(dialect.binary, options.cliPath());
        let schemaFile: string | undefined;
        if (request.outputSchema) {
          tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-workbench-schema-'));
          schemaFile = path.join(tempDir, 'schema.json');
          await fs.writeFile(schemaFile, JSON.stringify(request.outputSchema));
        }
        const { args, stdin } = dialect.build(request, { schemaFile });
        const parse = dialect.parser();
        // Read to the end even after the final answer, so the CLI can save its session before exiting.
        for await (const line of runLines({
          command, args, stdin, cwd: request.cwd, timeoutMs: request.timeoutMs,
          env: childEnv(options.env ?? process.env, command, options.proxyUrl()),
        }, signal)) {
          let event: unknown;
          try { event = JSON.parse(line); } catch { continue; }
          for (const parsed of parse(event)) {
            // An error before the final answer may be recovered (e.g. a reconnect); report it only if none comes.
            if (parsed.type === 'error') { lastError = parsed.message; continue; }
            if (final) continue;
            if (parsed.type === 'done') { final = parsed; continue; }
            yield parsed;
          }
        }
        if (final) yield final;
        else yield { type: 'error', message: lastError ?? `${dialect.name} 没有返回最终回答。` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const exitFailure = error instanceof ProcessError && error.kind === 'exit';
        yield { type: 'error', message: lastError && exitFailure ? `${lastError}（${message}）` : message };
      } finally {
        if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  };
}

/** Drain a run: stream deltas to `onDelta`, return the final text and session id, throw on error. */
export async function collect(events: AsyncIterable<AgentEvent>, onDelta?: (text: string) => void): Promise<{ text: string; sessionId?: string }> {
  let sessionId: string | undefined;
  let final: string | undefined;
  for await (const event of events) {
    if (event.type === 'session') sessionId = event.id;
    else if (event.type === 'text-delta') onDelta?.(event.text);
    else if (event.type === 'error') throw new Error(event.message);
    else final = event.text;
  }
  if (final !== undefined) return { text: final, sessionId };
  throw new Error('智能体没有返回最终回答。');
}

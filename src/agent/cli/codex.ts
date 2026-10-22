import type { AgentEvent, AgentRequest, CliDialect } from './adapter';

/**
 * `codex exec --json` / `codex exec resume`, flags checked against `codex exec --help` and
 * `codex exec resume --help` (codex-cli 0.163). `resume` has no -s/-C/--add-dir, so the sandbox
 * goes through `-c` there. The prompt is read from stdin (`-`), after `--` so that `-i <FILE>...`
 * cannot swallow it.
 */
export const codexDialect: CliDialect = {
  name: 'codex',
  binary: 'codex',
  build(request: AgentRequest, files) {
    const args = ['exec'];
    if (request.resumeId) args.push('resume');
    args.push('--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules');
    if (request.ephemeral) args.push('--ephemeral');
    if (request.model) args.push('-m', request.model);
    const sandbox = request.mode === 'write-workspace' ? 'workspace-write' : 'read-only';
    if (request.resumeId) args.push('-c', `sandbox_mode=${toml(sandbox)}`);
    else args.push('-s', sandbox, '-C', request.cwd);
    if (request.mode === 'write-workspace' && request.writableDirs?.length) {
      if (request.resumeId) args.push('-c', `sandbox_workspace_write.writable_roots=${toml(request.writableDirs)}`);
      else for (const dir of request.writableDirs) args.push('--add-dir', dir);
    }
    args.push(
      '-c', 'approval_policy="never"',
      '-c', `web_search=${toml(request.webSearch ? 'live' : 'disabled')}`,
      // No AGENTS.md from the working tree; instructions come only from us.
      '-c', 'project_doc_max_bytes=0',
    );
    if (request.instructions) args.push('-c', `developer_instructions=${toml(request.instructions)}`);
    if (files.schemaFile) args.push('--output-schema', files.schemaFile);
    for (const image of request.images ?? []) args.push('-i', image);
    args.push('--');
    if (request.resumeId) args.push(request.resumeId);
    args.push('-');
    return { args, stdin: request.prompt };
  },
  parser() {
    const messages = new Map<string, string>();
    let last = '';
    const emit = (id: string, text: string): AgentEvent[] => {
      const previous = messages.get(id);
      messages.set(id, text);
      last = text;
      if (previous === undefined) return [{ type: 'text-delta', text: (messages.size > 1 ? '\n\n' : '') + text }];
      return text.startsWith(previous) && text.length > previous.length ? [{ type: 'text-delta', text: text.slice(previous.length) }] : [];
    };
    return (raw): AgentEvent[] => {
      const event = raw as { type?: string; thread_id?: string; item?: { id?: string; type?: string; text?: string }; error?: { message?: string }; message?: string };
      switch (event.type) {
        case 'thread.started':
          return event.thread_id ? [{ type: 'session', id: event.thread_id }] : [];
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const item = event.item;
          if (item?.type !== 'agent_message' || typeof item.text !== 'string') return [];
          return emit(item.id ?? String(messages.size), item.text);
        }
        case 'turn.completed':
          return [{ type: 'done', text: last }];
        case 'turn.failed':
          return [{ type: 'error', message: event.error?.message ?? 'Codex 回答失败。' }];
        case 'error':
          return [{ type: 'error', message: event.message ?? event.error?.message ?? 'Codex 返回错误。' }];
        default:
          return [];
      }
    };
  },
};

/** JSON strings and arrays of strings are valid TOML values once DEL, which TOML forbids raw, is gone. */
function toml(value: string | string[]): string {
  return JSON.stringify(value).replace(/\x7f/g, '');
}

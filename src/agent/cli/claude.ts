import path from 'node:path';
import type { AgentEvent, AgentRequest, CliDialect } from './adapter';

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const WEB_TOOLS = ['WebSearch', 'WebFetch'];

/**
 * `claude -p --output-format stream-json`, flags checked against `claude --help` (2.1.303).
 * `--safe-mode` drops CLAUDE.md, skills, plugins, hooks and MCP servers from the user's setup;
 * `--tools` limits the built-in tools and `dontAsk` denies anything not allowed below, so the
 * only possible write is `note.md` in the workspace. The prompt is read from stdin.
 */
export const claudeDialect: CliDialect = {
  name: 'claude',
  binary: 'claude',
  build(request: AgentRequest) {
    const tools = [...READ_TOOLS, ...(request.webSearch ? WEB_TOOLS : [])];
    const allowed = [...tools];
    if (request.mode === 'write-workspace') {
      tools.push('Write', 'Edit');
      allowed.push('Write(./note.md)', 'Edit(./note.md)');
    }
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--safe-mode', '--strict-mcp-config',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--tools', tools.join(','),
      '--allowed-tools', allowed.join(','),
    ];
    const dirs = new Set([...(request.readableDirs ?? []), ...(request.images ?? []).map(image => path.dirname(image))]);
    for (const dir of dirs) args.push('--add-dir', dir);
    if (request.model) args.push('--model', request.model);
    if (request.resumeId) args.push('--resume', request.resumeId);
    if (request.ephemeral) args.push('--no-session-persistence');
    if (request.instructions) args.push('--append-system-prompt', request.instructions);
    if (request.outputSchema) args.push('--json-schema', JSON.stringify(request.outputSchema));
    // Claude has no image flag; the images are readable through --add-dir.
    const images = request.images?.length
      ? `\n\n<attached_images>\n${request.images.join('\n')}\n</attached_images>\n用 Read 工具查看上面的图片。`
      : '';
    return { args, stdin: request.prompt + images };
  },
  parser() {
    let text = '';
    let messageHasDeltas = false;
    return (raw): AgentEvent[] => {
      const event = raw as {
        type?: string; subtype?: string; session_id?: string; is_error?: boolean; result?: string; errors?: string[];
        structured_output?: unknown;
        event?: { type?: string; delta?: { type?: string; text?: string } };
        message?: { content?: { type?: string; text?: string }[] };
      };
      if (event.type === 'system' && event.subtype === 'init' && event.session_id) return [{ type: 'session', id: event.session_id }];
      if (event.type === 'stream_event') {
        const inner = event.event;
        if (inner?.type === 'message_start') { messageHasDeltas = false; return []; }
        if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && inner.delta.text) {
          const separator = !messageHasDeltas && text ? '\n\n' : '';
          messageHasDeltas = true;
          text += separator + inner.delta.text;
          return [{ type: 'text-delta', text: separator + inner.delta.text }];
        }
        return [];
      }
      if (event.type === 'assistant') {
        // Without partial messages (or if they were dropped), the whole message arrives here.
        if (messageHasDeltas) { messageHasDeltas = false; return []; }
        const body = (event.message?.content ?? []).filter(part => part.type === 'text' && part.text).map(part => part.text).join('');
        if (!body) return [];
        const separator = text ? '\n\n' : '';
        text += separator + body;
        return [{ type: 'text-delta', text: separator + body }];
      }
      if (event.type === 'result') {
        if (event.is_error || (event.subtype && event.subtype !== 'success')) {
          return [{ type: 'error', message: event.result || event.errors?.join('；') || `Claude 回答失败（${event.subtype ?? 'error'}）。` }];
        }
        const final = event.structured_output !== undefined ? JSON.stringify(event.structured_output) : (event.result ?? text);
        return [{ type: 'done', text: final }];
      }
      return [];
    };
  },
};

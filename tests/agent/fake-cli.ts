import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A stand-in for `codex` / `claude`: records argv, stdin, cwd and proxy variables to
 * $FAKE_RECORD, then plays the scenario named in $FAKE_SCENARIO.
 */
const SOURCE = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const out = event => process.stdout.write(JSON.stringify(event) + '\n');
let stdin = '';
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  if (process.env.FAKE_RECORD) {
    fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
      argv: process.argv.slice(2), stdin, cwd: process.cwd(),
      env: { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, ALL_PROXY: process.env.ALL_PROXY, NO_PROXY: process.env.NO_PROXY, PATH: process.env.PATH },
    }));
  }
  const scenario = process.env.FAKE_SCENARIO || 'codex-ok';
  if (scenario === 'codex-ok' || scenario === 'write-note') {
    if (scenario === 'write-note') fs.writeFileSync(path.join(process.cwd(), 'note.md'), process.env.FAKE_NOTE || '');
    out({ type: 'thread.started', thread_id: 'thread-123' });
    out({ type: 'turn.started' });
    out({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } });
    out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Hello' } });
    out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'World' } });
    out({ type: 'turn.completed', usage: {} });
  } else if (scenario === 'claude-ok') {
    out({ type: 'system', subtype: 'init', session_id: 'session-456' });
    out({ type: 'stream_event', event: { type: 'message_start' } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Hello', session_id: 'session-456' });
  } else if (scenario === 'fail') {
    out({ type: 'thread.started', thread_id: 'thread-123' });
    out({ type: 'turn.failed', error: { message: 'model refused' } });
    process.stderr.write('fatal: something broke\n');
    process.exit(3);
  } else if (scenario === 'hang') {
    // A grandchild in the same process group that would outlive a plain kill(pid).
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(process.env.FAKE_PIDS, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
    out({ type: 'thread.started', thread_id: 'thread-hang' });
    process.on('SIGTERM', () => {}); // ignore the polite signal; SIGKILL must follow
    setInterval(() => {}, 1000);
  }
});
`;

export function installFakeCli(name: 'codex' | 'claude'): { dir: string; cli: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pw-fake-cli-'));
  const cli = path.join(dir, name);
  writeFileSync(cli, SOURCE);
  chmodSync(cli, 0o755);
  return { dir, cli };
}

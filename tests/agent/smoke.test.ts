import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collect } from '../../src/agent/cli/adapter';
import { currentAgent } from '../../src/agent/runner';
import { readSettings } from '../../src/agent/settings';

// Real CLIs, a tiny prompt. Off by default: PAPER_WORKBENCH_CLI_SMOKE=1 pnpm test
const enabled = process.env.PAPER_WORKBENCH_CLI_SMOKE === '1';

for (const name of ['codex', 'claude'] as const) {
  test(`smoke: ${name} answers and returns a session id`, { skip: !enabled && 'set PAPER_WORKBENCH_CLI_SMOKE=1' }, async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'pw-smoke-'));
    try {
      const { adapter, model } = currentAgent(readSettings({ proxyUrl: process.env.PAPER_WORKBENCH_PROXY ?? '' }), name);
      const first = await collect(adapter.run({ prompt: 'Reply with exactly: pong', cwd, model, mode: 'read-only', timeoutMs: 180_000 }, new AbortController().signal));
      assert.match(first.text, /pong/i);
      assert.ok(first.sessionId);
      const second = await collect(adapter.run({ prompt: 'Repeat your previous reply.', cwd, model, mode: 'read-only', timeoutMs: 180_000, resumeId: first.sessionId }, new AbortController().signal));
      assert.match(second.text, /pong/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

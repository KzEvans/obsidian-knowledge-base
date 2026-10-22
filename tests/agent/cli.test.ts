import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { collect, createAdapter } from '../../src/agent/cli/adapter';
import type { AgentEvent, AgentRequest, CliDialect } from '../../src/agent/cli/adapter';
import { claudeDialect } from '../../src/agent/cli/claude';
import { codexDialect } from '../../src/agent/cli/codex';
import { childEnv, probeDirs, resolveCli } from '../../src/agent/cli/environment';
import { installFakeCli } from './fake-cli';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'pw-agent-cli-'));
const cleanup: string[] = [scratch];
after(() => { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }); });

const base: AgentRequest = { prompt: 'Q', cwd: '/work', timeoutMs: 10_000, mode: 'read-only' };

function fake(dialect: CliDialect, scenario: string, extra: Record<string, string> = {}, proxy = '') {
  const { dir, cli } = installFakeCli(dialect.binary as 'codex' | 'claude');
  cleanup.push(dir);
  const record = path.join(dir, 'record.json');
  const adapter = createAdapter(dialect, {
    cliPath: () => cli, proxyUrl: () => proxy,
    env: { ...process.env, FAKE_SCENARIO: scenario, FAKE_RECORD: record, FAKE_PIDS: path.join(dir, 'pids.json'), ...extra },
  });
  return { adapter, dir, record: () => JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; stdin: string; cwd: string; env: Record<string, string | undefined> } };
}

async function events(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of iterable) result.push(event);
  return result;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitDead(pid: number, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

// ---- argv ----

test('codex: a new read-only turn skips user config and reads the prompt from stdin', () => {
  const { args, stdin } = codexDialect.build({ ...base, instructions: 'Be "brief".\nOK', model: 'gpt-x', images: ['/a.png', '/b.png'] }, {});
  assert.deepEqual(args.slice(0, 5), ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules']);
  assert.ok(args.join(' ').includes('-s read-only -C /work'));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes('project_doc_max_bytes=0'));
  assert.ok(args.includes(`developer_instructions=${JSON.stringify('Be "brief".\nOK')}`));
  assert.deepEqual(args.slice(-6), ['-i', '/a.png', '-i', '/b.png', '--', '-']);
  assert.ok(args.includes('-m') && args[args.indexOf('-m') + 1] === 'gpt-x');
  assert.equal(stdin, 'Q');
});

test('codex: resume puts the sandbox in -c and the id after --', () => {
  const { args } = codexDialect.build({ ...base, resumeId: 'abc-1', images: ['/a.png'] }, {});
  assert.deepEqual(args.slice(0, 2), ['exec', 'resume']);
  assert.ok(args.includes('sandbox_mode="read-only"'));
  assert.ok(!args.includes('-s') && !args.includes('-C'));
  assert.deepEqual(args.slice(-5), ['-i', '/a.png', '--', 'abc-1', '-']);
});

test('codex: write-workspace, web search, schema and ephemeral', () => {
  const { args } = codexDialect.build({ ...base, mode: 'write-workspace', writableDirs: ['/extra'], webSearch: true, ephemeral: true }, { schemaFile: '/tmp/s.json' });
  assert.ok(args.join(' ').includes('-s workspace-write -C /work --add-dir /extra'));
  assert.ok(args.includes('web_search="live"'));
  assert.ok(args.includes('--ephemeral'));
  assert.equal(args[args.indexOf('--output-schema') + 1], '/tmp/s.json');
});

test('claude: read-only turn uses safe mode, read tools only and dontAsk', () => {
  const { args, stdin } = claudeDialect.build({ ...base, readableDirs: ['/vault'], images: ['/img/a.png'], instructions: 'Rules', model: 'opus' }, {});
  assert.deepEqual(args.slice(0, 5), ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
  for (const flag of ['--safe-mode', '--strict-mcp-config']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'Rules');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  const dirs = args.flatMap((arg, index) => arg === '--add-dir' ? [args[index + 1]] : []);
  assert.deepEqual(dirs, ['/vault', '/img']);
  assert.ok(stdin.startsWith('Q') && stdin.includes('/img/a.png'));
  assert.ok(!args.includes('--resume'));
});

test('claude: write-workspace allows only note.md; resume and web search', () => {
  const { args } = claudeDialect.build({ ...base, mode: 'write-workspace', resumeId: 'sess-9', webSearch: true, ephemeral: true, outputSchema: { type: 'object' } }, {});
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob,WebSearch,WebFetch,Write,Edit');
  assert.equal(args[args.indexOf('--allowed-tools') + 1], 'Read,Grep,Glob,WebSearch,WebFetch,Write(./note.md),Edit(./note.md)');
  assert.equal(args[args.indexOf('--resume') + 1], 'sess-9');
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--json-schema') + 1], '{"type":"object"}');
});

// ---- parsers ----

test('codex parser: session, deltas per message, final answer is the last message', () => {
  const parse = codexDialect.parser();
  const all = [
    { type: 'thread.started', thread_id: 't1' },
    { type: 'item.started', item: { id: 'a', type: 'agent_message', text: 'Hel' } },
    { type: 'item.updated', item: { id: 'a', type: 'agent_message', text: 'Hello' } },
    { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'Hello' } },
    { type: 'item.completed', item: { id: 'c', type: 'command_execution', text: 'ls' } },
    { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'Final' } },
    { type: 'turn.completed' },
  ].flatMap(event => parse(event));
  assert.deepEqual(all, [
    { type: 'session', id: 't1' },
    { type: 'text-delta', text: 'Hel' },
    { type: 'text-delta', text: 'lo' },
    { type: 'text-delta', text: '\n\nFinal' },
    { type: 'done', text: 'Final' },
  ]);
  assert.deepEqual(codexDialect.parser()({ type: 'turn.failed', error: { message: 'x' } }), [{ type: 'error', message: 'x' }]);
});

test('claude parser: partial deltas, no duplicate from the assistant message, result is final', () => {
  const parse = claudeDialect.parser();
  const all = [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } },
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'B' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'B' }] } },
    { type: 'result', subtype: 'success', result: 'B', session_id: 's1' },
  ].flatMap(event => parse(event));
  assert.deepEqual(all, [
    { type: 'session', id: 's1' },
    { type: 'text-delta', text: 'A' },
    { type: 'text-delta', text: '\n\nB' },
    { type: 'done', text: 'B' },
  ]);
  assert.deepEqual(claudeDialect.parser()({ type: 'assistant', message: { content: [{ type: 'text', text: 'whole' }] } }), [{ type: 'text-delta', text: 'whole' }]);
  assert.equal(claudeDialect.parser()({ type: 'result', subtype: 'error_max_turns', is_error: true })[0]?.type, 'error');
});

// ---- environment ----

test('CLI path: setting first, then ~/.local/bin, /opt/homebrew/bin, /usr/local/bin', () => {
  const home = '/home/u';
  assert.deepEqual(probeDirs(home), ['/home/u/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']);
  const only = (...files: string[]) => (file: string) => files.includes(file);
  assert.equal(resolveCli('codex', '', { home, exists: only('/opt/homebrew/bin/codex', '/usr/local/bin/codex') }), '/opt/homebrew/bin/codex');
  assert.equal(resolveCli('codex', '', { home, exists: only('/home/u/.local/bin/codex', '/opt/homebrew/bin/codex') }), '/home/u/.local/bin/codex');
  assert.equal(resolveCli('claude', '~/bin/claude', { home, exists: only('/home/u/bin/claude') }), '/home/u/bin/claude');
  assert.throws(() => resolveCli('claude', '/nope/claude', { home, exists: only('/usr/local/bin/claude') }), /不可执行/);
  assert.throws(() => resolveCli('codex', '', { home, exists: only() }), /未找到 codex/);
});

test('child environment: PATH completed, proxy injected, localhost bypassed', () => {
  const env = childEnv({ PATH: '/usr/bin:/custom', NO_PROXY: 'corp.example' }, '/x/bin/codex', 'http://127.0.0.1:7890', '/home/u');
  const dirs = env.PATH!.split(':');
  assert.deepEqual(dirs.slice(0, 4), ['/x/bin', '/home/u/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']);
  assert.ok(dirs.includes('/custom') && dirs.includes('/bin'));
  assert.equal(new Set(dirs).size, dirs.length);
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) assert.equal(env[key], 'http://127.0.0.1:7890');
  assert.ok(env.NO_PROXY!.split(',').includes('localhost'));
  assert.ok(env.NO_PROXY!.split(',').includes('corp.example'));
  const plain = childEnv({ PATH: '/usr/bin' }, '/x/codex', '  ', '/home/u');
  assert.equal(plain.HTTP_PROXY, undefined);
});

// ---- the real process path, with a fake CLI ----

test('fake codex: streams JSONL, receives stdin and the proxy', async () => {
  const run = fake(codexDialect, 'codex-ok', {}, 'http://proxy.test:8080');
  const deltas: string[] = [];
  const result = await collect(run.adapter.run({ ...base, cwd: scratch, prompt: '你好' }, new AbortController().signal), text => deltas.push(text));
  assert.deepEqual(result, { text: 'World', sessionId: 'thread-123' });
  assert.deepEqual(deltas, ['Hello', '\n\nWorld']);
  const record = run.record();
  assert.equal(record.stdin, '你好');
  assert.equal(record.env.HTTPS_PROXY, 'http://proxy.test:8080');
  assert.ok(record.env.NO_PROXY?.includes('localhost'));
  assert.ok(record.env.PATH?.split(':').includes(run.dir));
});

test('fake codex: resume passes the session id', async () => {
  const run = fake(codexDialect, 'codex-ok');
  await collect(run.adapter.run({ ...base, cwd: scratch, resumeId: 'thread-123' }, new AbortController().signal));
  const argv = run.record().argv;
  assert.deepEqual(argv.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(argv.slice(-3), ['--', 'thread-123', '-']);
});

test('fake claude: streams deltas and returns the result', async () => {
  const run = fake(claudeDialect, 'claude-ok');
  const deltas: string[] = [];
  const result = await collect(run.adapter.run({ ...base, cwd: scratch, resumeId: 'session-456' }, new AbortController().signal), text => deltas.push(text));
  assert.deepEqual(result, { text: 'Hello', sessionId: 'session-456' });
  assert.deepEqual(deltas, ['Hel', 'lo']);
  const argv = run.record().argv;
  assert.equal(argv[argv.indexOf('--resume') + 1], 'session-456');
});

test('fake codex: a failed turn reports the CLI message', async () => {
  const run = fake(codexDialect, 'fail');
  await assert.rejects(collect(run.adapter.run({ ...base, cwd: scratch }, new AbortController().signal)), /model refused/);
});

test('timeout kills the whole process group, grandchild included', async () => {
  const run = fake(codexDialect, 'hang');
  const started = Date.now();
  await assert.rejects(collect(run.adapter.run({ ...base, cwd: scratch, timeoutMs: 800 }, new AbortController().signal)), /秒未完成/);
  assert.ok(Date.now() - started < 6000);
  const pids = JSON.parse(readFileSync(path.join(run.dir, 'pids.json'), 'utf8')) as { child: number; grandchild: number };
  assert.ok(await waitDead(pids.child), 'child still running');
  assert.ok(await waitDead(pids.grandchild), 'grandchild still running');
});

test('cancel kills the whole process group, grandchild included', async () => {
  const run = fake(codexDialect, 'hang');
  const controller = new AbortController();
  const seen: AgentEvent[] = [];
  const pending = events(run.adapter.run({ ...base, cwd: scratch, timeoutMs: 60_000 }, controller.signal));
  // Wait for the fake to report its pids, then stop.
  const pidFile = path.join(run.dir, 'pids.json');
  for (let tries = 0; tries < 100; tries += 1) {
    try { readFileSync(pidFile); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  controller.abort();
  seen.push(...await pending);
  assert.deepEqual(seen.at(-1), { type: 'error', message: '已取消。' });
  const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { child: number; grandchild: number };
  assert.ok(await waitDead(pids.child), 'child still running');
  assert.ok(await waitDead(pids.grandchild), 'grandchild still running');
});

test('a missing CLI is an error event, not a crash', async () => {
  const adapter = createAdapter(codexDialect, { cliPath: () => path.join(scratch, 'missing-codex'), proxyUrl: () => '' });
  const all = await events(adapter.run({ ...base, cwd: scratch }, new AbortController().signal));
  assert.equal(all.length, 1);
  assert.equal(all[0]?.type, 'error');
});


test('the final answer is returned only after the CLI has saved its session and exited', async () => {
  const saved = path.join(scratch, 'saved-session');
  const run = fake(codexDialect, 'delayed-save', { FAKE_SAVED: saved });
  await collect(run.adapter.run({ ...base, cwd: scratch }, new AbortController().signal));
  assert.equal(readFileSync(saved, 'utf8'), 'saved');
});

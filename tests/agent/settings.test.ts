import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MAX_STORED_MESSAGES, importLegacySettings, renameSession, sessionFor, trimSession } from '../../src/agent/chat/sessions';
import { DEFAULT_TIMEOUT_MINUTES, readSettings } from '../../src/agent/settings';
import { currentAgent } from '../../src/agent/runner';

test('settings tolerate missing and invalid fields; Codex is the default', () => {
  const settings = readSettings({ adapter: 'gpt', generationTimeoutMinutes: -3, codexPath: 7, window: { left: 'x', top: 10 } });
  assert.equal(settings.adapter, 'codex');
  assert.equal(settings.generationTimeoutMinutes, DEFAULT_TIMEOUT_MINUTES);
  assert.equal(settings.codexPath, '');
  assert.deepEqual(settings.window, { top: 10 });
  assert.equal(readSettings({ adapter: 'claude' }).adapter, 'claude');
  assert.deepEqual(readSettings(undefined).sessions, {});
});

test('Codex reasoning defaults to high, preserves choices and survives saving', () => {
  assert.equal(readSettings(undefined).codexReasoningEffort, 'high');
  assert.equal(readSettings({ codexReasoningEffort: 'invalid' }).codexReasoningEffort, 'high');
  for (const effort of ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    const settings = readSettings({ codexReasoningEffort: effort });
    assert.equal(settings.codexReasoningEffort, effort);
    assert.equal(readSettings(JSON.parse(JSON.stringify(settings))).codexReasoningEffort, effort);
  }
});

test('the current agent uses the latest Codex reasoning selection', () => {
  const settings = readSettings({});
  assert.equal(currentAgent(settings).reasoningEffort, 'high');
  settings.codexReasoningEffort = 'xhigh';
  assert.equal(currentAgent(settings).reasoningEffort, 'xhigh');
  assert.equal(currentAgent(settings, 'claude').reasoningEffort, undefined);
  settings.codexReasoningEffort = '';
  assert.equal(currentAgent(settings).reasoningEffort, undefined);
});

test('codex-note-chat sessions and options are imported once, existing values win, old review data is dropped', () => {
  const settings = readSettings({ proxyUrl: 'http://mine:1' });
  settings.sessions['wiki/papers/keep.md'] = { adapter: 'claude', threadId: 'mine', messages: [], savedCount: 0, updatedAt: '' };
  importLegacySettings(settings, {
    includeOutlinks: true, contextCollapsed: true, window: { left: 5, top: 6, width: 500, height: 600 },
    sessions: {
      'wiki/papers/a.md': { threadId: 'thread-old', savedCount: 9, review: { status: 'pass' }, messages: [
        { role: 'user', kind: 'review', text: 'q', at: 't' }, { role: 'assistant', text: 'a', at: 't' }, { role: 'system', text: 'x' },
      ] },
      'wiki/papers/keep.md': { threadId: 'theirs', messages: [] },
    },
  }, { codex_path: '/opt/codex', proxy_url: 'http://old:2', forge_model: 'gpt-5' });
  const imported = settings.sessions['wiki/papers/a.md']!;
  assert.equal(imported.adapter, 'codex');
  assert.equal(imported.threadId, 'thread-old');
  assert.equal(imported.messages.length, 2);
  assert.equal(imported.savedCount, 2);
  assert.ok(!('review' in imported));
  assert.equal(settings.sessions['wiki/papers/keep.md'].threadId, 'mine');
  assert.equal(settings.includeOutlinks, true);
  assert.equal(settings.contextCollapsed, true);
  assert.deepEqual(settings.window, { left: 5, top: 6, width: 500, height: 600 });
  assert.equal(settings.codexPath, '/opt/codex');
  assert.equal(settings.proxyUrl, 'http://mine:1');
  assert.equal(settings.codexModel, 'gpt-5');
  assert.equal(settings.legacyImported, true);
  // The data survives a save/load round trip.
  assert.deepEqual(readSettings(JSON.parse(JSON.stringify(settings))), settings);
});

test('sessions follow renames and are trimmed with savedCount', () => {
  const settings = readSettings({});
  const session = sessionFor(settings, 'a.md');
  assert.equal(sessionFor(settings, 'a.md'), session);
  assert.ok(renameSession(settings, 'a.md', 'b/a.md'));
  assert.equal(settings.sessions['b/a.md'], session);
  assert.equal(settings.sessions['a.md'], undefined);
  assert.equal(renameSession(settings, 'missing.md', 'x.md'), false);
  session.messages = Array.from({ length: MAX_STORED_MESSAGES + 5 }, () => ({ role: 'user' as const, text: 'x', at: '' }));
  session.savedCount = 10;
  trimSession(session);
  assert.equal(session.messages.length, MAX_STORED_MESSAGES);
  assert.equal(session.savedCount, 5);
});

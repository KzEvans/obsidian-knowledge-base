import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Manifest } from '../../src/core/types';
import type * as Status from '../../src/reader/status';
import type { StatusAction } from '../../src/reader/status';
import { dom, load } from './harness';

const status = load<typeof Status>('src/reader/status.ts');

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return { schemaVersion: 1, sha256: 'a'.repeat(64), sources: [], stage: 'parsing', failure: null, priority: false, updatedAt: 'now', ...overrides };
}

test('stages read as queued, parsing, translating; progress shows when known', async () => {
  const { describeStatus } = await status;
  assert.equal(describeStatus({ manifest: manifest({ stage: 'discovered' }), conflicts: [], pipelineLoaded: true }).title, '排队中');
  const parsing = describeStatus({ manifest: manifest(), parse: { done: 3, total: 12 }, conflicts: [], pipelineLoaded: true });
  assert.equal(parsing.title, '解析中');
  assert.equal(parsing.detail, '3/12 页');
  assert.equal(parsing.progress, 0.25);
  assert.deepEqual(parsing.actions, ['prioritize']);
  const translating = describeStatus({ manifest: manifest({ stage: 'translating', translation: { model: 'm', total: 10, done: 4, failed: 0, at: 'now' } }), conflicts: [], pipelineLoaded: true });
  assert.equal(translating.title, '翻译中');
  assert.equal(translating.detail, '4/10 段');
  const prioritized = describeStatus({ manifest: manifest({ priority: true }), conflicts: [], pipelineLoaded: true });
  assert.deepEqual(prioritized.actions, []);
  assert.equal(prioritized.detail, '已优先');
});

test('failure shows the failed stage, the redacted error and a retry', async () => {
  const { describeStatus } = await status;
  const view = describeStatus({ manifest: manifest({ stage: 'failed', failure: { stage: 'uploading', error: 'HTTP 500', attempts: 3, at: 'now', retryable: true } }), conflicts: [], pipelineLoaded: true });
  assert.equal(view.title, '解析中（上传）阶段失败');
  assert.equal(view.detail, 'HTTP 500 · 已尝试 3 次');
  assert.deepEqual(view.actions, ['retry']);
  assert.equal(view.error, true);
});

test('an unknown PDF asks to be processed; without the library module nothing is offered', async () => {
  const { describeStatus } = await status;
  assert.deepEqual(describeStatus({ conflicts: [], pipelineLoaded: true }).actions, ['request']);
  const missing = describeStatus({ manifest: manifest({ stage: 'failed', failure: { stage: 'parsing', error: 'x', attempts: 1, at: 'now', retryable: true } }), conflicts: [], pipelineLoaded: false });
  assert.deepEqual(missing.actions, []);
  assert.ok(missing.detail?.includes('文献库模块未加载'));
  const conflict = describeStatus({ manifest: manifest({ stage: 'conflict' }), conflicts: ['manifest 2.json'], pipelineLoaded: true });
  assert.ok(conflict.detail?.includes('manifest 2.json'));
});

test('the status panel renders title, progress and working action buttons', async () => {
  const { renderStatus, describeStatus } = await status;
  const { document } = dom();
  const panel = document.body.createDiv();
  const actions: StatusAction[] = [];
  let closed = false;
  renderStatus(panel, describeStatus({ manifest: manifest(), parse: { done: 1, total: 4 }, conflicts: [], pipelineLoaded: true }), { action: action => actions.push(action), close: () => { closed = true; } });
  assert.equal(panel.querySelector('strong')?.textContent, '解析中');
  assert.equal(panel.querySelector('progress')?.getAttribute('max') ?? String((panel.querySelector('progress') as HTMLProgressElement).max), '1');
  assert.equal(panel.getAttribute('role'), 'status');
  const buttons = Array.from(panel.querySelectorAll('button'));
  assert.deepEqual(buttons.map(button => button.textContent), ['优先处理这篇', '继续原 PDF']);
  buttons[0]!.dispatchEvent(new document.defaultView!.Event('click'));
  buttons[1]!.dispatchEvent(new document.defaultView!.Event('click'));
  assert.deepEqual(actions, ['prioritize']);
  assert.ok(closed);
});

test('the Chinese toggle is grey before translation, shows progress while translating', async () => {
  const { languageButton } = await status;
  const none = languageButton('en', manifest({ stage: 'normalizing' }), undefined, undefined);
  assert.deepEqual(none, { enabled: false, text: '中文', title: '全文翻译尚未开始' });
  const starting = languageButton('en', manifest({ stage: 'translating' }), { schemaVersion: 1, entries: {}, failures: {} }, { done: 0, total: 40 });
  assert.equal(starting.enabled, false);
  assert.equal(starting.text, '中文 0%');
  const entries = { a: { text: '译', model: 'm', termsKey: 'k', at: 'now' } };
  const partial = languageButton('en', manifest({ stage: 'translating' }), { schemaVersion: 1, entries, failures: {} }, { done: 10, total: 40 });
  assert.deepEqual([partial.enabled, partial.text], [true, '中文 25%']);
  assert.ok(partial.title.includes('10/40'));
  const done = languageButton('zh', manifest({ stage: 'ready' }), { schemaVersion: 1, entries, failures: {} }, undefined);
  assert.deepEqual([done.enabled, done.text], [true, 'English']);
});

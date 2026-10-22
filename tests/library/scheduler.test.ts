import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EventBus } from '../../src/core/events';
import { Scheduler } from '../../src/library/scheduler';
import type { SyncStatus } from '../../src/library/scheduler';
import { statusText } from '../../src/library/ui';
import { deferred } from './helpers';

// The still-relevant cases of legacy tests/test_doc_sync_scheduler.js: sync, enrichment and the
// pipeline never block each other; failures are visible, quiet and retryable; overlapping triggers do not stack.

function fixture(sync: () => Promise<{ copied: number; failed: number; errors: string[] }>, enrich: () => Promise<void> = async () => undefined) {
  const notices: string[] = [];
  const statuses: SyncStatus[] = [];
  const events = new EventBus();
  const finished: unknown[] = [];
  events.on('zotero:sync-finished', payload => finished.push(payload));
  const scheduler = new Scheduler({ sync, enrich, events, notify: message => notices.push(message), onStatus: status => statuses.push(status), log: { warn: () => undefined } });
  return { scheduler, notices, statuses, finished };
}

test('overlapping refresh ticks start no extra sync and release the busy flag', async () => {
  const gate = deferred();
  let calls = 0;
  const { scheduler } = fixture(async () => { calls++; await gate.promise; return { copied: 0, failed: 0, errors: [] }; });
  const first = scheduler.sync(false);
  assert.equal(scheduler.syncBusy, true);
  assert.equal(await scheduler.sync(false), false);
  assert.equal(calls, 1);
  gate.resolve();
  await first;
  assert.equal(scheduler.syncBusy, false);
  await scheduler.sync(false);
  assert.equal(calls, 2);
});

test('a failed background refresh is visible, quiet and retryable', async () => {
  let offline = true;
  const { scheduler, notices, statuses, finished } = fixture(async () => {
    if (offline) throw new Error('Zotero 没有运行或未开启本地 API（ECONNREFUSED），下一轮自动重试。');
    return { copied: 1, failed: 0, errors: [] };
  });
  await scheduler.sync(false);
  assert.equal(scheduler.syncBusy, false);
  assert.equal(statuses.at(-1)?.state, 'failed');
  assert.match(statuses.at(-1)?.message ?? '', /Zotero 没有运行/);
  assert.match(statusText(scheduler.status, [], false), /Zotero 同步失败/);
  assert.deepEqual(notices, []);
  assert.deepEqual(finished.at(-1), { ok: false, copied: 0, failed: 0, error: statuses.at(-1)?.message });
  offline = false;
  await scheduler.sync(false);
  assert.equal(statuses.at(-1)?.state, 'ok');
  assert.match(statusText(scheduler.status, [], false), /^Zotero \d\d:\d\d$/);
});

test('a manual sync reports through notices; a manual sync while one runs says so', async () => {
  const gate = deferred();
  const { scheduler, notices } = fixture(async () => { await gate.promise; return { copied: 2, failed: 0, errors: [] }; });
  const running = scheduler.sync(true);
  await scheduler.sync(true);
  gate.resolve();
  await running;
  assert.ok(notices.includes('Zotero 同步已开始。'));
  assert.ok(notices.some(text => text.includes('正在运行')));
  assert.ok(notices.some(text => text.includes('同步已完成，复制 2 篇')));
});

test('a slow sync does not block enrichment, and a slow enrichment does not block the sync', async () => {
  const syncGate = deferred(), enrichGate = deferred();
  let enriched = 0, synced = 0;
  const { scheduler } = fixture(async () => { synced++; await syncGate.promise; return { copied: 0, failed: 0, errors: [] }; }, async () => { enriched++; await enrichGate.promise; });
  const sync = scheduler.sync(false);
  const enrich = scheduler.enrich();
  assert.equal(synced, 1);
  assert.equal(enriched, 1);
  assert.equal(await scheduler.enrich(), false);
  enrichGate.resolve();
  await enrich;
  syncGate.resolve();
  await sync;
});

test('an enrichment failure releases its flag without affecting the sync status', async () => {
  const { scheduler, statuses } = fixture(async () => ({ copied: 0, failed: 0, errors: [] }), async () => { throw new Error('agent offline'); });
  assert.equal(await scheduler.enrich(), true);
  assert.equal(await scheduler.enrich(), true);
  await scheduler.sync(false);
  assert.equal(statuses.at(-1)?.state, 'ok');
});

test('partial failures (one attachment) are reported as a failed, retryable sync', async () => {
  const { scheduler, finished } = fixture(async () => ({ copied: 3, failed: 1, errors: ['K1：Zotero 附件文件不存在'] }));
  await scheduler.sync(false);
  assert.equal(scheduler.status.state, 'failed');
  assert.deepEqual(finished.at(-1), { ok: false, copied: 3, failed: 1, error: '1 项失败：K1：Zotero 附件文件不存在' });
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CancelledError, TaskQueue, attemptsOf, withRetry } from '../../src/core/queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('concurrency is bounded and priority jobs start before ordinary waiting ones', async () => {
  const queue = new TaskQueue(2);
  const started: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const job = (key: string, priority = false) => {
    const gate = deferred(); gates.set(key, gate);
    return queue.enqueue(key, async () => { started.push(key); await gate.promise; return key; }, { priority });
  };
  const results = [job('a'), job('b'), job('c'), job('d'), job('urgent', true)];
  await tick();
  assert.deepEqual(started, ['a', 'b']);
  gates.get('a')!.resolve();
  await tick(); await tick();
  assert.deepEqual(started, ['a', 'b', 'urgent']);
  queue.prioritize('d');
  gates.get('b')!.resolve();
  await tick(); await tick();
  assert.deepEqual(started, ['a', 'b', 'urgent', 'd']);
  for (const gate of gates.values()) gate.resolve();
  await tick(); await tick(); await tick();
  for (const gate of gates.values()) gate.resolve();
  assert.deepEqual(await Promise.all(results), ['a', 'b', 'c', 'd', 'urgent']);
});

test('pause lets running jobs finish but starts nothing new; resume continues', async () => {
  const queue = new TaskQueue(1);
  const started: string[] = [];
  const gate = deferred();
  const first = queue.enqueue('one', async () => { started.push('one'); await gate.promise; });
  const second = queue.enqueue('two', async () => { started.push('two'); });
  await tick();
  queue.pause();
  gate.resolve();
  await first;
  await tick();
  assert.deepEqual(started, ['one']);
  assert.equal(queue.paused, true);
  queue.resume();
  await second;
  assert.deepEqual(started, ['one', 'two']);
});

test('cancel rejects a waiting job and aborts a running one', async () => {
  const queue = new TaskQueue(1);
  const running = queue.enqueue('run', signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')))));
  const waiting = queue.enqueue('wait', async () => 'never');
  queue.cancel('wait');
  await assert.rejects(waiting, CancelledError);
  await tick();
  queue.cancel('run');
  await assert.rejects(running, CancelledError);
  assert.equal(queue.size, 0);
});

test('a duplicate key is refused instead of running twice', async () => {
  const queue = new TaskQueue(1);
  const gate = deferred();
  const first = queue.enqueue('same', () => gate.promise);
  await assert.rejects(queue.enqueue('same', async () => undefined), /已在队列中/);
  gate.resolve();
  await first;
});

test('a failing job does not stop the queue', async () => {
  const queue = new TaskQueue(1);
  const failed = queue.enqueue('bad', () => Promise.reject(new Error('boom')));
  const next = queue.enqueue('good', async () => 'ok');
  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'ok');
});

test('retry backs off on retryable errors and records attempts', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const value = await withRetry(async () => { if (++calls < 3) throw new Error('network'); return 'done'; }, {
    delays: [5, 10, 20], sleep: async ms => { sleeps.push(ms); },
  });
  assert.equal(value, 'done');
  assert.deepEqual(sleeps, [5, 10]);
});

test('retry stops at once on non-retryable errors and after the last delay', async () => {
  const fatal = Object.assign(new Error('401'), { fatal: true });
  await assert.rejects(withRetry(() => Promise.reject(fatal), { delays: [1], sleep: async () => undefined, isRetryable: error => !(error as { fatal?: boolean }).fatal }),
    (error: unknown) => error === fatal && attemptsOf(error) === 1);
  let calls = 0;
  await assert.rejects(withRetry(() => { calls++; return Promise.reject(new Error('still down')); }, { delays: [1, 1], sleep: async () => undefined }),
    (error: unknown) => attemptsOf(error) === 3);
  assert.equal(calls, 3);
});

test('an aborted retry loop stops waiting', async () => {
  const controller = new AbortController();
  const pending = withRetry(() => Promise.reject(new Error('down')), { delays: [60_000], signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(pending, CancelledError);
});

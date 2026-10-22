import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { LibraryContext } from '../../src/core/module';
import { register } from '../../src/library';
import { Pipeline } from '../../src/library/pipeline/pipeline';
import { readSettings } from '../../src/library/settings';
import type { LibrarySettings } from '../../src/library/settings';
import { pipelineFixture, silentLog } from './pipeline-fixture';

test('a saved pause applies before layout and legacy-cache import can begin', async () => {
  const fixture = await pipelineFixture();
  const layoutCallbacks: Array<() => void> = [];
  const intervals: number[] = [];
  const cleanups: Array<() => void> = [];
  // Only registration runs: layout callbacks (and any potentially slow import) stay pending.
  const context = {
    app: { vault: { adapter: {}, configDir: '.obsidian' }, workspace: { onLayoutReady: (callback: () => void) => layoutCallbacks.push(callback) } },
    plugin: {
      addStatusBarItem: () => ({ addClass() {} }),
      registerDomEvent() {},
      register: (cleanup: () => void) => cleanups.push(cleanup),
      registerInterval: (interval: number) => intervals.push(interval),
      addCommand() {}, addRibbonIcon() {},
    },
    services: {}, events: fixture.events, store: fixture.store,
    settings: readSettings({ pipelinePaused: true }),
    core: { glossary: [] }, qwenMt: fixture.qwen,
    secrets: { get: () => null }, log: silentLog,
    vaultPath: fixture.base, pluginDir: fixture.base,
  } as unknown as LibraryContext<LibrarySettings>;
  const handle = register(context);
  try {
    assert.equal(layoutCallbacks.length, 1);
    assert.ok(context.services.pipeline instanceof Pipeline);
    assert.equal(context.services.pipeline.paused, true);
    assert.deepEqual(fixture.qwen.calls, []);
  } finally {
    handle.dispose?.();
    for (const interval of intervals) window.clearInterval(interval);
    for (const cleanup of cleanups) cleanup();
  }
});

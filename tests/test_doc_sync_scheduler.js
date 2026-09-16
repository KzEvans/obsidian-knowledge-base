const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../plugins/zotero-doc-sync/main.js"), "utf8");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function element() {
  return {
    textContent: "", style: {}, dataset: {},
    setAttribute() {}, addClass() {}, addEventListener() {},
    createEl: element,
  };
}

async function fixture() {
  const notices = [];
  const intervals = [];
  const timeouts = [];
  const context = {
    require(name) {
      if (name === "obsidian") {
        return { Plugin: class {}, Notice: class { constructor(text) { notices.push(text); } } };
      }
      return require(name);
    },
    module: { exports: {} },
    console: { log() {}, warn() {}, error() {} },
    window: {
      setInterval(callback, ms) { const timer = { callback, ms }; intervals.push(timer); return timer; },
      clearInterval(timer) { timer.cleared = true; },
      setTimeout(callback, ms) { timeouts.push({ callback, ms }); },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const plugin = new context.module.exports();
  Object.assign(plugin, {
    addStatusBarItem: element,
    addCommand() {}, addRibbonIcon() {}, registerEvent() {}, registerInterval() {},
    loadData: async () => ({ lastLintAt: Date.now() }), saveData: async () => {},
    progressNotice: () => ({ update() {}, complete() {}, fail() {} }),
    app: {
      vault: { adapter: { getBasePath: () => "/fixture" } },
      workspace: { on() {}, onLayoutReady() {}, getActiveFile: () => null },
      metadataCache: { on() {} },
    },
    execPython: async () => { throw new Error("Unexpected Python invocation in test"); },
  });
  await plugin.onload();
  const minuteTimers = intervals.filter(timer => timer.ms === 60000);
  assert.equal(minuteTimers.length, 2, "source and knowledge workers need separate timers");
  return { plugin, notices, timeouts, syncTick: minuteTimers[0].callback, workerTick: minuteTimers[1].callback };
}

test("minute refresh continues during long generation without overlapping knowledge jobs", async () => {
  const { plugin, syncTick, workerTick } = await fixture();
  const generation = deferred();
  const generating = deferred();
  let syncs = 0, scans = 0, ingests = 0;
  plugin.execPython = async (script, args, timeout) => {
    if (script === plugin.syncScript) {
      assert.equal(timeout, 5 * 60000);
      syncs++;
    } else if (args[0] === "scan") scans++;
    else if (args[0] === "ingest-next") {
      assert.equal(timeout, 35 * 60000);
      ingests++;
      generating.resolve();
      await generation.promise;
    } else assert.fail("Unexpected command");
  };
  const running = workerTick();
  await generating.promise;
  const progress = plugin.pipelineStatusItem.textContent;
  await syncTick();
  await syncTick();
  await workerTick();
  assert.equal(syncs, 2);
  assert.equal(scans, 1);
  assert.equal(ingests, 1);
  assert.equal(plugin.busy, true);
  assert.equal(plugin.pipelineStatusItem.textContent, progress, "sync must not overwrite generation status");
  generation.resolve();
  await running;
  assert.equal(plugin.busy, false);
});

test("overlapping refresh ticks share no extra subprocess and release the sync lock", async () => {
  const { plugin, syncTick } = await fixture();
  const syncing = deferred();
  let calls = 0;
  plugin.execPython = async () => { calls++; await syncing.promise; };
  const first = syncTick();
  assert.equal(plugin.syncBusy, true);
  assert.equal(await syncTick(), false);
  assert.equal(calls, 1);
  syncing.resolve();
  await first;
  assert.equal(plugin.syncBusy, false);
  await syncTick();
  assert.equal(calls, 2);
});

test("slow source refresh does not block queued local knowledge work", async () => {
  const { plugin, syncTick, workerTick } = await fixture();
  const syncing = deferred();
  const commands = [];
  plugin.execPython = async (script, args) => {
    if (script === plugin.syncScript) await syncing.promise;
    else commands.push(args[0]);
  };
  const running = syncTick();
  await workerTick();
  assert.equal(plugin.syncBusy, true);
  assert.deepEqual(commands, ["scan", "ingest-next"]);
  syncing.resolve();
  await running;
});

test("failed background refresh is visible, quiet, retryable and independent of generation", async () => {
  const { plugin, notices, syncTick, workerTick } = await fixture();
  let offline = true;
  const commands = [];
  plugin.execPython = async (script, args) => {
    if (script === plugin.syncScript) {
      if (offline) throw new Error("Zotero offline");
    } else commands.push(args[0]);
  };
  await syncTick();
  assert.equal(plugin.syncBusy, false);
  assert.match(plugin.syncStatusItem.textContent, /同步失败.*Zotero offline/);
  await workerTick();
  assert.deepEqual(commands, ["scan", "ingest-next"]);
  assert.match(plugin.pipelineStatusItem.textContent, /已完成/);
  assert.match(plugin.syncStatusItem.textContent, /同步失败/);
  assert.deepEqual(notices, []);
  offline = false;
  await syncTick();
  assert.match(plugin.syncStatusItem.textContent, /最近同步/);
});

test("manual sync remains available during intensive reading without starting another job", async () => {
  const { plugin, notices } = await fixture();
  plugin.busy = true;
  let syncs = 0;
  plugin.execPython = async (script) => {
    assert.equal(script, plugin.syncScript, "busy knowledge worker must not be invoked");
    syncs++;
  };
  await plugin.runCycle(true);
  assert.equal(syncs, 1);
  assert.equal(plugin.busy, true);
  assert.ok(notices.some(text => text.includes("同步已完成")));
  assert.ok(notices.some(text => text.includes("知识库任务正在运行")));
});

test("new sources mirrored during generation are rescanned when the worker is free", async () => {
  const { plugin, syncTick, workerTick } = await fixture();
  let manifestRevision = 0;
  const scanned = [];
  plugin.busy = true;
  plugin.execPython = async (script, args) => {
    if (script === plugin.syncScript) manifestRevision++;
    else if (args[0] === "scan") scanned.push(manifestRevision);
    else assert.equal(args[0], "ingest-next");
  };
  await syncTick();
  await workerTick();
  assert.deepEqual(scanned, []);
  plugin.busy = false;
  await workerTick();
  assert.deepEqual(scanned, [1]);
});

test("startup keeps sync-before-scan order and manual offline sync still processes local tasks", async () => {
  const { plugin, notices, timeouts } = await fixture();
  const calls = [];
  let offline = false;
  plugin.execPython = async (script, args) => {
    if (script === plugin.syncScript) {
      calls.push("sync");
      if (offline) throw new Error("Zotero offline");
    } else calls.push(args[0]);
  };
  await timeouts.find(timer => timer.ms === 3000).callback();
  assert.deepEqual(calls, ["sync", "scan", "ingest-next"]);
  calls.length = 0;
  offline = true;
  await plugin.runCycle(true);
  assert.deepEqual(calls, ["sync", "scan", "ingest-next"]);
  assert.ok(notices.some(text => text.includes("同步失败")));
  assert.ok(!notices.some(text => text.includes("同步已完成")));
});

test("knowledge failure releases its lock without disabling later source refresh", async () => {
  const { plugin, syncTick, workerTick } = await fixture();
  plugin.execPython = async (script) => {
    if (script === plugin.pipelineScript) throw new Error("generation failed");
  };
  await workerTick();
  assert.equal(plugin.busy, false);
  await syncTick();
  assert.match(plugin.syncStatusItem.textContent, /最近同步/);
  assert.match(plugin.pipelineStatusItem.textContent, /失败/);
});

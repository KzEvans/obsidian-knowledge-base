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

function element(tag = "", options = {}) {
  const result = {
    tag, textContent: options.text || "", value: "", style: {}, dataset: {}, events: {}, children: [],
    setAttribute() {}, addClass() {},
    addEventListener(event, callback) { this.events[event] = callback; },
    focus() { this.focused = true; },
    empty() { this.children = []; },
    createEl(childTag, childOptions) {
      const child = element(childTag, childOptions);
      this.children.push(child);
      return child;
    },
  };
  return result;
}

async function fixture() {
  const notices = [];
  const intervals = [];
  const timeouts = [];
  const commands = new Map();
  const modals = [];
  const context = {
    require(name) {
      if (name === "obsidian") {
        return {
          Plugin: class {}, Notice: class { constructor(text) { notices.push(text); } },
          Modal: class {
            constructor(app) { this.app = app; this.contentEl = element(); }
            open() { modals.push(this); this.onOpen(); }
            close() { this.closed = true; this.onClose(); }
          },
        };
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
    addCommand(command) { commands.set(command.id, command); }, addRibbonIcon() {}, registerEvent() {}, registerInterval() {},
    loadData: async () => ({ lastLintAt: Date.now() }), saveData: async () => {},
    progressNotice: () => ({ update() {}, complete() {}, fail() {} }),
    app: {
      vault: { adapter: { getBasePath: () => "/fixture" } },
      workspace: { on() {}, onLayoutReady() {}, getActiveFile: () => null },
      metadataCache: { on() {}, getFileCache: () => ({}) },
    },
    execPython: async () => { throw new Error("Unexpected Python invocation in test"); },
  });
  await plugin.onload();
  const sourceTimers = intervals.filter(timer => timer.ms === 3 * 60 * 60 * 1000);
  const workerTimers = intervals.filter(timer => timer.ms === 60000);
  assert.equal(sourceTimers.length, 1, "Zotero sources must refresh every three hours");
  assert.equal(workerTimers.length, 1, "only the local knowledge worker polls every minute");
  return { plugin, notices, timeouts, commands, modals, syncTick: sourceTimers[0].callback, workerTick: workerTimers[0].callback };
}

test("collection notes retain primary-paper commands while logs and images remain excluded", async () => {
  const { plugin } = await fixture();
  assert.equal(plugin.isPrimaryPaper({ path: "wiki/papers/DEA/Subtopic/Paper.md" }), true);
  assert.equal(plugin.isPrimaryPaper({ path: "wiki/papers/自适应聚合物网络/Paper.md" }), true);
  for (const path of ["wiki/papers/images/Paper.md", "wiki/papers/close-reading/Paper.md", "wiki/papers/../Paper.md"]) {
    assert.equal(plugin.isPrimaryPaper({ path }), false);
  }
});

test("paper ingestion allows the configured job deadline plus five minutes", async () => {
  const { plugin } = await fixture();
  plugin.app.vault.adapter.read = async (configPath) => {
    assert.equal(configPath, "system/knowledge/config.json");
    return JSON.stringify({ forge_job_timeout_seconds: 3600 });
  };
  const onProgress = () => {};
  plugin.execPython = async (script, args, timeout, progress) => {
    assert.equal(script, plugin.pipelineScript);
    assert.equal(args[0], "ingest-next");
    assert.equal(timeout, 65 * 60000);
    assert.equal(progress, onProgress);
    return "done";
  };
  assert.equal(await plugin.runPipeline(["ingest-next"], undefined, onProgress), "done");
});

test("paper ingestion keeps the 35-minute default when no job deadline is configured", async () => {
  const { plugin } = await fixture();
  plugin.app.vault.adapter.read = async () => "{}";
  plugin.execPython = async (_script, _args, timeout) => {
    assert.equal(timeout, 35 * 60000);
  };
  await plugin.runPipeline(["ingest-next"]);
});

test("paper ingestion keeps the 35-minute default when its configuration is missing", async () => {
  const { plugin } = await fixture();
  plugin.app.vault.adapter.read = async () => { throw new Error("File not found"); };
  plugin.execPython = async (_script, _args, timeout) => {
    assert.equal(timeout, 35 * 60000);
  };
  await plugin.runPipeline(["ingest-next"]);
});

test("explicit pipeline timeouts are preserved without reading Forge configuration", async () => {
  const { plugin } = await fixture();
  plugin.app.vault.adapter.read = async () => assert.fail("Explicit timeout must bypass configuration");
  plugin.execPython = async (_script, _args, timeout) => {
    assert.equal(timeout, 30000);
  };
  await plugin.runPipeline(["ingest-next"], 30000);
});

test("local knowledge report opens the returned report without model health checking or ingestion", async () => {
  const { plugin } = await fixture();
  const opened = [];
  plugin.app.workspace.openLinkText = async (...args) => opened.push(args);
  plugin.execPython = async (_script, args, timeout) => {
    assert.deepEqual(Array.from(args), ["knowledge-map", "--report"]);
    assert.equal(timeout, 30000);
    return JSON.stringify({ report_path: "system/reports/local-knowledge-map.md" });
  };
  await plugin.showKnowledgeMap();
  assert.deepEqual(opened, [["system/reports/local-knowledge-map.md", "", true]]);
});

test("evidence comparison command opens a real question modal and rejects empty input", async () => {
  const { plugin, commands, modals, notices } = await fixture();
  assert.equal(commands.get("compare-evidence").name, "生成跨论文证据对比");
  let calls = 0;
  plugin.execPython = async () => { calls++; };
  commands.get("compare-evidence").callback();
  assert.equal(modals.length, 1);
  const modal = modals[0];
  const input = modal.contentEl.children.find(child => child.tag === "textarea");
  const submit = modal.contentEl.children.find(child => child.tag === "button");
  assert.ok(input && submit, "The registered command must expose an input and report button");
  input.value = "   ";
  await submit.events.click();
  assert.equal(calls, 0);
  assert.equal(modal.closed, undefined);
  assert.ok(notices.includes("请输入要比较的问题"));
});

test("comparison modal submits a question with its current primary-paper anchor and opens its report", async () => {
  const { plugin, commands, modals } = await fixture();
  const opened = [];
  plugin.app.workspace.getActiveFile = () => ({ path: "wiki/papers/自适应聚合物网络/Paper.md" });
  plugin.app.vault.adapter.read = async () => JSON.stringify({ ingest_paused: true });
  plugin.app.workspace.openLinkText = async (...args) => opened.push(args);
  plugin.execPython = async (_script, args, timeout) => {
    assert.deepEqual(Array.from(args), ["compare-evidence", "--question", "比较应力松弛条件",
      "--note", "wiki/papers/自适应聚合物网络/Paper.md", "--report"]);
    assert.equal(timeout, 30000);
    return JSON.stringify({ report_path: "system/reports/evidence-comparison.md" });
  };
  commands.get("compare-evidence").callback();
  const modal = modals[0];
  modal.contentEl.children.find(child => child.tag === "textarea").value = "  比较应力松弛条件  ";
  await modal.contentEl.children.find(child => child.tag === "button").events.click();
  assert.equal(modal.closed, true);
  assert.deepEqual(opened, [["system/reports/evidence-comparison.md", "", true]]);
  assert.equal(plugin.busy, false);
});

test("comparison accepts experiment anchors and omits canonical or auxiliary notes", async () => {
  for (const activePath of ["wiki/experiments/Experiment.md", "wiki/concepts/Concept.md",
    "wiki/papers/close-reading/Paper.md", "wiki/papers/images/Image.md", "wiki/papers/../Outside.md"]) {
    const { plugin } = await fixture();
    plugin.app.workspace.getActiveFile = () => ({ path: activePath });
    plugin.app.workspace.openLinkText = async () => {};
    plugin.execPython = async (_script, args, timeout) => {
      assert.equal(args[0], "compare-evidence");
      assert.equal(timeout, 30000);
      assert.equal(args.includes("--note"), activePath === "wiki/experiments/Experiment.md");
      return JSON.stringify({ report_path: "system/reports/evidence-comparison.md" });
    };
    await plugin.compareEvidence("比较问题");
  }
});

test("concept and question report commands remain available while generation is paused", async () => {
  const { plugin, commands } = await fixture();
  plugin.app.vault.adapter.read = async () => JSON.stringify({ ingest_paused: true });
  const opened = [], invoked = [];
  plugin.app.workspace.openLinkText = async (...args) => opened.push(args);
  const paths = {
    "maintain-concepts": "system/reports/concept-maintenance.md",
    "maintain-questions": "system/reports/research-question-maintenance.md",
  };
  plugin.execPython = async (_script, args, timeout) => {
    assert.ok(args[0] in paths, "Reports must not invoke ingest, lint or approval");
    assert.deepEqual(Array.from(args), [args[0], "--report"]);
    assert.equal(timeout, 30000);
    assert.equal(plugin.busy, true);
    invoked.push(args[0]);
    return JSON.stringify({ report_path: paths[args[0]] });
  };
  assert.equal(commands.get("maintain-concepts").name, "查看同义概念整理建议");
  assert.equal(commands.get("maintain-questions").name, "更新研究问题整理报告");
  await commands.get("maintain-concepts").callback();
  await commands.get("maintain-questions").callback();
  assert.deepEqual(invoked, ["maintain-concepts", "maintain-questions"]);
  assert.deepEqual(opened, [[paths["maintain-concepts"], "", true], [paths["maintain-questions"], "", true]]);
  assert.equal(plugin.busy, false);
});

test("report consumers surface invalid JSON or unexpected paths and release the lock", async () => {
  for (const output of ["not JSON", JSON.stringify({ report_path: "wiki/concepts/Unrelated.md" })]) {
    const { plugin, commands, notices } = await fixture();
    plugin.app.workspace.openLinkText = async () => assert.fail("Invalid report must not open");
    plugin.execPython = async () => output;
    await commands.get("maintain-concepts").callback();
    assert.equal(plugin.busy, false);
    assert.ok(notices.some(text => text.includes("失败")));
  }
});

test("report commands respect the existing knowledge lock without starting another subprocess", async () => {
  const { plugin, commands, notices } = await fixture();
  plugin.busy = true;
  plugin.execPython = async () => assert.fail("Busy report must not start another job");
  await commands.get("maintain-questions").callback();
  assert.ok(notices.some(text => text.includes("知识库任务正在运行")));
  assert.equal(plugin.busy, true);
});

test("other pipeline commands keep the 35-minute default without reading Forge configuration", async () => {
  const { plugin } = await fixture();
  plugin.app.vault.adapter.read = async () => assert.fail("Non-ingest commands must bypass Forge configuration");
  plugin.execPython = async (_script, args, timeout) => {
    assert.equal(args[0], "scan");
    assert.equal(timeout, 35 * 60000);
  };
  await plugin.runPipeline(["scan"]);
});

test("three-hour source refresh remains independent of minute knowledge polling", async () => {
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

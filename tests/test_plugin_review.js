const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const repo = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(repo, "plugins/codex-note-chat/main.js"), "utf8");
const context = {
  require(name) {
    if (name === "obsidian") return { Plugin: class {} };
    if (name === "electron") return {};
    return require(name);
  },
  module: { exports: {} }, console,
};
vm.createContext(context);
vm.runInContext(source + "\nmodule.exports.test = { reviewContentHash, completeReviewInMarkdown, inspectReviewSection };", context);
const { reviewContentHash, completeReviewInMarkdown, inspectReviewSection } = context.module.exports.test;
const original = "---\ntype: paper\nstatus: draft\nreviewed: false\nvalidation_status: draft_with_warnings\n---\n# Paper\n## 人工复核\n- [ ] 核对单位\n";
const reviewed = completeReviewInMarkdown(original, "2026-09-05T00:00:00Z");
const digest = reviewContentHash(reviewed);
assert.match(reviewed, /status: reviewed/);
assert.match(reviewed, /- \[x\] 核对单位/);
assert.equal(inspectReviewSection(reviewed, { reviewed: true, status: "reviewed", reviewed_content_sha256: digest }).reviewed, true);
assert.equal(inspectReviewSection(reviewed + "Changed", { reviewed: true, status: "reviewed", reviewed_content_sha256: digest }).reviewed, false);
const python = spawnSync("python3", ["-c", "import importlib.util,sys; s=importlib.util.spec_from_file_location('p',sys.argv[1]); p=importlib.util.module_from_spec(s); s.loader.exec_module(p); t=sys.stdin.read(); p.validate_review_gate(t); print(p.review_content_hash(t))", path.join(repo, "knowledge-base/system/knowledge/run_pipeline.py")], { input: reviewed, encoding: "utf8" });
assert.equal(python.status, 0, python.stderr);
assert.equal(python.stdout.trim(), digest);

const syncSource = fs.readFileSync(path.join(repo, "plugins/zotero-doc-sync/main.js"), "utf8");
const syncContext = { require: context.require, module: { exports: {} }, console };
vm.createContext(syncContext);
vm.runInContext(syncSource, syncContext);
const plugin = new syncContext.module.exports();
assert.equal(plugin.progressEvent('KB_PROGRESS {"percent":null,"message":"planning"}').message, "planning");
let outerTimeout;
plugin.execPython = (_script, _args, timeout) => { outerTimeout = timeout; };
plugin.app = { vault: { adapter: { getBasePath: () => "/fixture" } } };
plugin.runPipeline(["ingest-next"]);
assert.equal(outerTimeout, 35 * 60 * 1000);
console.log("Plugin review/hash parity and progress contract tests passed.");

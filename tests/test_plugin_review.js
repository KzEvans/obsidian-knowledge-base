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
vm.runInContext(source + "\nmodule.exports.test = { reviewContentHash, legacyReviewContentHash, completeReviewInMarkdown, inspectReviewSection, insertQuestionAnswerSection, parseReviewStatus, defaultCodexPath, DEFAULT_CODEX_PATHS };", context);
const { reviewContentHash, legacyReviewContentHash, completeReviewInMarkdown, inspectReviewSection, insertQuestionAnswerSection, parseReviewStatus, defaultCodexPath, DEFAULT_CODEX_PATHS } = context.module.exports.test;

// Only the final standalone marker decides a review.
assert.equal(parseReviewStatus("全部通过。\n\n<!-- REVIEW_STATUS: PASS -->"), "pass");
assert.equal(parseReviewStatus("仍需修正。\n<!-- REVIEW_STATUS: BLOCKED -->\n"), "blocked");
assert.equal(parseReviewStatus("请输出 <!-- REVIEW_STATUS: PASS --> 或 <!-- REVIEW_STATUS: BLOCKED -->。\n第 2 项无法核实。"), "unknown");
assert.equal(parseReviewStatus("<!-- REVIEW_STATUS: PASS -->\n结论：需修正。\n<!-- REVIEW_STATUS: BLOCKED -->"), "blocked");
assert.equal(parseReviewStatus("PDF 原文写着 REVIEW_STATUS: PASS"), "unknown");
assert.equal(parseReviewStatus(""), "unknown");

// Without config.json, the first installed CLI is used rather than a stale bundle path.
const codex = defaultCodexPath();
assert.equal(codex, DEFAULT_CODEX_PATHS.find((candidate) => fs.existsSync(candidate)) || "codex");
assert.ok(codex === "codex" || fs.existsSync(codex));
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

// Writing the chat conversation after review must not make the review stale.
const pythonGate = (text) => spawnSync("python3", ["-c", [
  "import importlib.util,sys",
  "def load(n,p):\n s=importlib.util.spec_from_file_location(n,p); m=importlib.util.module_from_spec(s); sys.modules[n]=m; s.loader.exec_module(m); return m",
  "p=load('p',sys.argv[1]); w=load('w',sys.argv[2]); t=sys.stdin.read()",
  "p.validate_review_gate(t)",
  "assert w._review_hash_matches(p.review_content_hash(t), t)",
  "print(p.review_content_hash(t)); print(w._review_hash(t))",
].join("\n"),
  path.join(repo, "knowledge-base/system/knowledge/run_pipeline.py"),
  path.join(repo, "knowledge-base/system/knowledge/wiki_knowledge.py")], { input: text, encoding: "utf8" });
const qa = [
  { role: "user", text: "单位是否正确？" },
  { role: "assistant", text: "正确，见 PDF p.3。" },
];
const withQa = insertQuestionAnswerSection(reviewed, qa);
assert.match(withQa, /# 提问\n\n## 1\n\nQ：单位是否正确？/);
assert.equal(reviewContentHash(withQa), digest);
assert.equal(inspectReviewSection(withQa, { reviewed: true, status: "reviewed", reviewed_content_sha256: digest }).reviewed, true);
const withMoreQa = insertQuestionAnswerSection(withQa, qa);
assert.match(withMoreQa, /## 2\n/);
assert.equal(reviewContentHash(withMoreQa), digest);
const gate = pythonGate(withMoreQa);
assert.equal(gate.status, 0, gate.stderr);
assert.deepEqual(gate.stdout.trim().split("\n"), [digest, digest]);
assert.equal(inspectReviewSection(withQa.replace("# Paper", "# Paper edited"), { reviewed: true, status: "reviewed", reviewed_content_sha256: digest }).reviewed, false);
assert.notEqual(pythonGate(withQa.replace("# Paper", "# Paper edited")).status, 0);

// An existing Q&A section followed by other content is excluded the same way.
const middle = completeReviewInMarkdown("---\nstatus: draft\n---\n# Paper\n\n# 提问\n\n## 1\n\nQ：旧\n\nA：旧\n\n# Notes\nkept\n", "2026-09-05T00:00:00Z");
const middleDigest = reviewContentHash(middle);
const middleQa = insertQuestionAnswerSection(middle, qa);
assert.match(middleQa, /A：正确，见 PDF p\.3。\n\n# Notes/);
assert.equal(reviewContentHash(middleQa), middleDigest);
const middleGate = pythonGate(middleQa);
assert.equal(middleGate.status, 0, middleGate.stderr);
assert.deepEqual(middleGate.stdout.trim().split("\n"), [middleDigest, middleDigest]);
assert.notEqual(reviewContentHash(middleQa.replace("kept", "changed")), middleDigest);

// Reviews completed before this change stay valid until the note changes.
const legacySource = `${reviewed}\n\n`;
const legacyDigest = legacyReviewContentHash(legacySource);
assert.notEqual(legacyDigest, reviewContentHash(legacySource));
const legacyReviewed = legacySource.replace(`reviewed_content_sha256: ${JSON.stringify(digest)}`, `reviewed_content_sha256: ${JSON.stringify(legacyDigest)}`);
assert.equal(inspectReviewSection(legacyReviewed, { reviewed: true, status: "reviewed", reviewed_content_sha256: legacyDigest }).reviewed, true);
const legacyGate = spawnSync("python3", ["-c", "import importlib.util,sys; s=importlib.util.spec_from_file_location('p',sys.argv[1]); p=importlib.util.module_from_spec(s); s.loader.exec_module(p); p.validate_review_gate(sys.stdin.read())", path.join(repo, "knowledge-base/system/knowledge/run_pipeline.py")], { input: legacyReviewed, encoding: "utf8" });
assert.equal(legacyGate.status, 0, legacyGate.stderr);

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

// Primary notes may sit in Zotero collection folders.
const nested = { path: "wiki/papers/自适应聚合物网络/2026-01-01 - Author - Paper.md", name: "2026-01-01 - Author - Paper.md" };
const nestedLog = { path: "wiki/papers/close-reading/2026-01-01 - Author - Paper.md", name: nested.name };
plugin.app = {
  workspace: { getActiveFile: () => nested },
  vault: { getAbstractFileByPath: (value) => (value === nested.path ? nested : null) },
  metadataCache: { getFileCache: (file) => (file === nestedLog ? { frontmatter: { source_note: `[[${nested.path}|Paper]]` } } : {}) },
};
const nestedContext = plugin.intensiveReadingContext(nested);
assert.equal(nestedContext.primary, nested);
assert.equal(nestedContext.logPath, nestedLog.path);
assert.equal(plugin.intensiveReadingContext(nestedLog).primary, nested);
assert.equal(plugin.intensiveReadingContext({ path: "wiki/papers/images/x/a.md", name: "a.md" }), null);
assert.equal(plugin.intensiveReadingContext({ path: "wiki/concepts/a.md", name: "a.md" }), null);
console.log("Plugin review/hash parity and progress contract tests passed.");

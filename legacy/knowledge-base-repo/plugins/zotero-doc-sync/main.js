const { Modal, Notice, Plugin } = require("obsidian");
const { execFile } = require("child_process");
const path = require("path");

module.exports = class ZoteroDocSyncPlugin extends Plugin {
  async onload() {
    this.busy = false;
    this.syncBusy = false;
    this.syncStatusItem = this.addStatusBarItem();
    this.syncStatusItem.setAttribute("role", "status");
    this.syncStatusItem.setAttribute("aria-live", "polite");
    this.syncStatusItem.textContent = "Zotero：等待同步";
    this.pipelineStatusItem = this.addStatusBarItem();
    this.pipelineStatusItem.setAttribute("role", "status");
    this.pipelineStatusItem.setAttribute("aria-live", "polite");
    this.paragraphReadingSelections = new Map();
    this.pluginData = (await this.loadData()) || {};
    if (!this.pluginData.lastLintAt) {
      this.pluginData.lastLintAt = Date.now();
      await this.saveData(this.pluginData);
    }

    this.addCommand({
      id: "sync-now",
      name: "立即同步 Zotero 并处理下一条知识任务",
      callback: () => this.runCycle(true),
    });

    this.addCommand({
      id: "process-next-knowledge-task",
      name: "处理下一条知识任务",
      callback: () => this.processNext(true),
    });

    this.addCommand({
      id: "start-or-continue-paragraph-reading",
      name: "开始或继续当前论文的交互式全文精读",
      callback: () => this.runIntensiveReadingAction("continue", "逐段精读"),
    });

    this.addCommand({
      id: "hint-current-intensive-reading-unit",
      name: "获取当前精读单元的分级提示",
      callback: () => this.runIntensiveReadingAction("hint", "精读提示"),
    });

    this.addCommand({
      id: "submit-current-intensive-reading-understanding",
      name: "提交当前精读单元的初始理解",
      callback: () => this.runIntensiveReadingAction("submit-initial", "提交初始理解"),
    });

    this.addCommand({
      id: "explain-current-intensive-reading-unit",
      name: "查看当前精读单元的专家解释",
      callback: () => this.runIntensiveReadingAction("explain", "精读解释"),
    });

    this.addCommand({
      id: "merge-current-intensive-reading-unit",
      name: "合并当前已验证精读单元",
      callback: () => this.mergeCurrentIntensiveReadingUnit(),
    });

    this.addCommand({
      id: "approve-and-integrate-current-note",
      name: "整合当前已完成人工审核的知识笔记",
      callback: () => this.approveAndIntegrateCurrent(),
    });

    this.addCommand({
      id: "retry-failed-knowledge-task",
      name: "重试最早的失败知识任务",
      callback: () => this.retryFailed(),
    });

    this.addCommand({
      id: "repair-current-forge-draft",
      name: "只校验并修复当前 Forge 草稿（不重新全文生成）",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!this.isPrimaryPaper(file)) return new Notice("请先打开主论文草稿");
        return this.withLock(true, "草稿校验与修复", async (onProgress) => {
          await this.runPipeline(["repair", "--note", file.path]);
          await this.runPipeline(["ingest-next", "--note", file.path], undefined, onProgress);
        }, { progress: true });
      },
    });

    this.addCommand({
      id: "run-wiki-health-check",
      name: "运行知识库健康检查",
      callback: () => this.runLint(true),
    });

    this.addCommand({
      id: "show-local-knowledge-map",
      name: "查看知识关联与整理线索",
      callback: () => this.showKnowledgeMap(),
    });

    this.addCommand({
      id: "compare-evidence",
      name: "生成跨论文证据对比",
      callback: () => this.openEvidenceComparison(),
    });

    this.addCommand({
      id: "maintain-concepts",
      name: "查看同义概念整理建议",
      callback: () => this.openKnowledgeReport(
        ["maintain-concepts", "--report"], "同义概念整理建议", "system/reports/concept-maintenance.md"
      ),
    });

    this.addCommand({
      id: "maintain-questions",
      name: "更新研究问题整理报告",
      callback: () => this.openKnowledgeReport(
        ["maintain-questions", "--report"], "研究问题整理报告", "system/reports/research-question-maintenance.md"
      ),
    });

    this.addCommand({
      id: "show-knowledge-queue-status",
      name: "显示知识任务队列状态",
      callback: () => this.showQueueStatus(),
    });

    this.addRibbonIcon("refresh-cw", "同步 Zotero 并生成知识笔记", () => {
      this.runCycle(true);
    });

    this.submitStatusItem = this.addStatusBarItem();
    this.submitStatusItem.addClass("kb-intensive-submit-wrap");
    this.submitButton = this.submitStatusItem.createEl("button", {
      cls: "kb-intensive-submit",
      text: "提交初始理解",
    });
    this.submitButton.type = "button";
    this.submitButton.setAttribute("aria-label", "提交当前精读单元的初始理解");
    this.submitButton.addEventListener("click", () => {
      const action = this.submitButton.dataset.action || "submit-initial";
      const label = action === "continue" ? "迁移精读格式" : "提交初始理解";
      this.runIntensiveReadingAction(action, label);
    });
    this.submitStatusItem.style.display = "none";

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.rememberParagraphReadingSelection(file);
        this.refreshSubmitControl();
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refreshSubmitControl())
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => this.handleMetadataChange(file))
    );
    this.app.workspace.onLayoutReady(() => {
      this.rememberParagraphReadingSelection(this.app.workspace.getActiveFile());
      this.refreshSubmitControl();
    });

    // Source refresh must not wait for a long-running Forge/intensive-reading job.
    // Only the knowledge worker owns `busy`; source refresh owns `syncBusy`.
    this.registerInterval(window.setInterval(() => this.syncSources(false), 3 * 60 * 60 * 1000));
    this.registerInterval(window.setInterval(() => this.processNext(false), 60 * 1000));
    this.registerInterval(window.setInterval(() => this.runEnrichment(), 60 * 60 * 1000));
    this.registerInterval(window.setInterval(() => this.maybeRunWeeklyLint(), 6 * 60 * 60 * 1000));

    window.setTimeout(() => this.runCycle(false), 3000);
    window.setTimeout(() => this.maybeRunWeeklyLint(), 15000);
    window.setTimeout(() => this.runEnrichment(), 10000);
  }

  get basePath() {
    return this.app.vault.adapter.getBasePath();
  }

  get syncScript() {
    return path.join(this.basePath, "system", "zotero-sync", "sync_zotero_doc.py");
  }

  get pipelineScript() {
    return path.join(this.basePath, "system", "knowledge", "run_pipeline.py");
  }

  isPrimaryPaper(file) {
    return Boolean(file && /^wiki\/papers\/(?!images\/|close-reading\/).+\.md$/.test(file.path)
      && !file.path.split("/").includes(".."));
  }

  isChecked(value) {
    return value === true || value === "true";
  }

  rememberParagraphReadingSelection(file) {
    if (!this.isPrimaryPaper(file)) return;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    this.paragraphReadingSelections.set(file.path, this.isChecked(frontmatter.paragraph_reading));
  }

  handleMetadataChange(file) {
    const active = this.app.workspace.getActiveFile();
    if (this.isPrimaryPaper(file)) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      const selected = this.isChecked(frontmatter.paragraph_reading);
      const previous = this.paragraphReadingSelections.get(file.path);
      this.paragraphReadingSelections.set(file.path, selected);
      if (active?.path === file.path && previous === false && selected) {
        window.setTimeout(
          () => this.runIntensiveReadingAction("continue", "逐段精读"),
          0
        );
      }
    }
    if (active?.path === file.path) this.refreshSubmitControl();
  }

  refreshSubmitControl() {
    if (!this.submitStatusItem || !this.submitButton) return;
    const file = this.app.workspace.getActiveFile();
    const isLog = Boolean(file?.path.startsWith("wiki/papers/close-reading/"));
    const frontmatter = file
      ? this.app.metadataCache.getFileCache(file)?.frontmatter || {}
      : {};
    const waiting =
      isLog && String(frontmatter.interaction_stage || "") === "awaiting_initial_analysis";
    this.submitStatusItem.style.display = waiting ? "" : "none";
    if (!waiting) return;
    const unit = String(frontmatter.current_unit || "当前单元");
    const legacy =
      String(frontmatter.workflow || "") !== "full-text-unlabeled-paragraph-pairs";
    this.submitButton.dataset.action = legacy ? "continue" : "submit-initial";
    this.submitButton.textContent = this.busy
      ? "处理中…"
      : legacy
        ? `更新 ${unit} 精读格式`
        : `提交 ${unit} 初始理解`;
    this.submitButton.disabled = this.busy;
    this.submitButton.setAttribute("aria-busy", this.busy ? "true" : "false");
    this.submitButton.setAttribute(
      "aria-label",
      legacy ? `将 ${unit} 更新为逐段原文与翻译格式` : `提交 ${unit} 的初始理解`
    );
  }

  progressNotice(label) {
    const notice = new Notice("", 0);
    const root = notice.noticeEl;
    root.replaceChildren();
    root.addClass("kb-progress-notice");
    const header = root.createDiv({ cls: "kb-progress-header" });
    const title = header.createSpan({ cls: "kb-progress-title", text: label });
    const percent = header.createSpan({ cls: "kb-progress-percent", text: "处理中" });
    const progress = root.createEl("progress", { cls: "kb-progress-track" });
    progress.max = 100;
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    const status = root.createDiv({ cls: "kb-progress-status", text: "正在启动…" });
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    title.setAttribute("aria-hidden", "true");
    percent.setAttribute("aria-hidden", "true");

    const update = (event) => {
      const value = typeof event?.percent === "number" ? Math.max(0, Math.min(100, event.percent)) : null;
      if (value === null) {
        progress.removeAttribute("value");
        progress.removeAttribute("aria-valuenow");
      } else {
        progress.value = value;
        progress.setAttribute("aria-valuenow", String(value));
      }
      percent.textContent = value === null ? "处理中" : `${value}%`;
      status.textContent = String(event?.message || "正在处理…");
      progress.setAttribute("aria-label", `${label}：${status.textContent}`);
    };
    return {
      update,
      complete(message) {
        update({ percent: 100, message });
        window.setTimeout(() => notice.hide(), 1800);
      },
      fail() {
        notice.hide();
      },
    };
  }

  progressEvent(line) {
    if (!line.startsWith("KB_PROGRESS ")) return null;
    try {
      const event = JSON.parse(line.slice("KB_PROGRESS ".length));
      if (event.percent !== null && typeof event.percent !== "number") return null;
      return event;
    } catch (_error) {
      return null;
    }
  }

  execPython(script, args, timeoutMs, onProgress) {
    return new Promise((resolve, reject) => {
      let pending = "";
      const child = execFile(
        "/usr/bin/python3",
        [script, ...args],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (stdout) console.log("[Knowledge Base]", stdout.trim());
          if (stderr) console.warn("[Knowledge Base]", stderr.trim());
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
          } else {
            resolve(stdout || "");
          }
        }
      );
      if (child.stdout && onProgress) {
        child.stdout.on("data", (chunk) => {
          pending += String(chunk);
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() || "";
          for (const line of lines) {
            const event = this.progressEvent(line.trim());
            if (event) onProgress(event);
          }
        });
      }
    });
  }

  async runPipeline(args, timeoutMs, onProgress) {
    if (timeoutMs === undefined) {
      timeoutMs = 35 * 60 * 1000;
      if (args[0] === "ingest-next") {
        try {
          const config = JSON.parse(await this.app.vault.adapter.read("system/knowledge/config.json"));
          const seconds = config.forge_job_timeout_seconds;
          if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
            timeoutMs = (seconds + 300) * 1000;
          }
        } catch (_error) {
          // Missing or unreadable configuration retains the existing 35-minute limit.
        }
      }
    }
    return this.execPython(this.pipelineScript, args, timeoutMs, onProgress);
  }

  errorDetail(error) {
    const raw = String(error?.stderr || error?.stdout || error?.message || "未知错误");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("KB_PROGRESS "));
    return (lines[lines.length - 1] || "未知错误").replace(/^\[[^\]]+\]\s*/, "");
  }

  async withLock(showNotice, label, operation, options = {}) {
    if (this.busy) {
      if (showNotice) new Notice("知识库任务正在运行，请稍后再试");
      return;
    }
    this.busy = true;
    this.refreshSubmitControl();
    const reporter = options.progress ? this.progressNotice(label) : null;
    const startedAt = Date.now();
    let stage = label;
    let idleSeconds = null;
    const stageLabels = {
      source_extraction: "提取 PDF（计入 30 分钟）", planning: "阅读全文并构建计划",
      plan_saved: "分析计划已保存", plan_resumed: "复用已有分析计划", drafting: "撰写候选稿",
      generation_running: "准备分析", deterministic_validation: "确定性校验",
      table_normalization: "整理表格", repair_running: "修复实质校验问题", draft_admitted: "草稿已保存，待人工审核",
    };
    const render = () => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const message = `${stage} · 已用 ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}${idleSeconds !== null ? ` · 距后台输出 ${idleSeconds} 秒` : ""}`;
      this.pipelineStatusItem.textContent = message;
      reporter?.update({ percent: null, message });
    };
    const onProgress = (event) => {
      if (!event.activity_only) stage = stageLabels[event.stage] || event.message || stage;
      idleSeconds = event.activity_only ? event.output_idle_seconds : null;
      render();
    };
    render();
    const timer = window.setInterval(render, 1000);
    if (showNotice && !reporter) new Notice(`${label}已开始`);
    try {
      await operation(onProgress);
      this.pipelineStatusItem.textContent = `${label}已完成`;
      if (reporter) reporter.complete(`${label}已完成`);
      else if (showNotice) new Notice(`${label}已完成`);
    } catch (error) {
      console.error(`[Knowledge Base] ${label}`, error);
      if (reporter) reporter.fail();
      this.pipelineStatusItem.textContent = `${label}失败：${this.errorDetail(error)}`;
      new Notice(`${label}失败：${this.errorDetail(error)}`, 10000);
    } finally {
      window.clearInterval(timer);
      this.busy = false;
      this.refreshSubmitControl();
    }
  }

  async runCycle(showNotice) {
    if (!(await this.syncSources(showNotice))) return;
    return this.processNext(showNotice);
  }

  async syncSources(showNotice) {
    if (this.syncBusy) {
      if (showNotice) new Notice("Zotero 同步正在运行，请稍后再试");
      return false;
    }
    this.syncBusy = true;
    this.syncStatusItem.textContent = "Zotero：正在同步…";
    if (showNotice) new Notice("Zotero 同步已开始");
    try {
      await this.execPython(this.syncScript, [], 5 * 60 * 1000);
      this.syncStatusItem.textContent = `Zotero：最近同步 ${new Date().toLocaleTimeString()}`;
      if (showNotice) new Notice("Zotero 同步已完成");
    } catch (error) {
      console.warn("[Knowledge Base] Zotero sync failed; knowledge worker remains independent", error);
      const message = `Zotero 同步失败：${this.errorDetail(error)}`;
      this.syncStatusItem.textContent = message;
      if (showNotice) new Notice(message, 10000);
    } finally {
      this.syncBusy = false;
    }
    // Already mirrored sources can still be processed when Zotero is offline.
    return true;
  }

  async runEnrichment() {
    if (this.enrichmentBusy) return;
    this.enrichmentBusy = true;
    try {
      await this.execPython(this.syncScript, ["--enrich"], 15 * 60 * 1000);
    } catch (error) {
      console.warn("[Knowledge Base] SI/JIF enrichment deferred", error);
    } finally {
      this.enrichmentBusy = false;
    }
  }

  async processNext(showNotice) {
    return this.withLock(showNotice, "知识笔记生成", async (onProgress) => {
      await this.runPipeline(["scan"]);
      await this.runPipeline(["ingest-next"], undefined, onProgress);
    }, { progress: showNotice });
  }

  intensiveReadingContext(file = this.app.workspace.getActiveFile()) {
    if (!file) return null;
    // Collection folders mirror Zotero; the runner accepts nested primary notes.
    if (this.isPrimaryPaper(file)) {
      return {
        active: file,
        primary: file,
        logPath: path.posix.join("wiki", "papers", "close-reading", file.name),
      };
    }
    if (!file.path.startsWith("wiki/papers/close-reading/")) return null;
    const logFrontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const rawSource = String(logFrontmatter.source_note || "");
    const match = rawSource.match(/^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]$/);
    if (!match) return null;
    const primary = this.app.vault.getAbstractFileByPath(match[1]);
    if (!this.isPrimaryPaper(primary)) return null;
    return { active: file, primary, logPath: file.path };
  }

  async runIntensiveReadingAction(action, label) {
    const context = this.intensiveReadingContext();
    if (!context) {
      new Notice("请先打开主论文笔记或其逐段精读日志");
      return;
    }
    const frontmatter = this.app.metadataCache.getFileCache(context.primary)?.frontmatter || {};
    if (frontmatter.paragraph_reading !== true && frontmatter.paragraph_reading !== "true") {
      new Notice("请先在主论文笔记属性中勾选 paragraph_reading");
      return;
    }

    return this.withLock(true, label, async (onProgress) => {
      await this.runPipeline(
        ["paragraph-read", "--note", context.primary.path, "--action", action],
        35 * 60 * 1000,
        onProgress
      );
      const companion = this.app.vault.getAbstractFileByPath(context.logPath);
      if (companion) {
        await this.app.workspace.getLeaf("tab").openFile(companion);
      }
    }, { progress: true });
  }

  async mergeCurrentIntensiveReadingUnit() {
    const context = this.intensiveReadingContext();
    if (!context) {
      new Notice("请先打开主论文笔记或其逐段精读日志");
      return;
    }
    return this.withLock(true, "精读单元合并", async (onProgress) => {
      await this.runPipeline(
        ["paragraph-merge", "--note", context.primary.path],
        35 * 60 * 1000,
        onProgress
      );
      await this.app.workspace.getLeaf("tab").openFile(context.primary);
    }, { progress: true });
  }

  async approveAndIntegrateCurrent() {
    const file = this.app.workspace.getActiveFile();
    if (file?.path.startsWith("wiki/papers/close-reading/")) {
      new Notice("精读日志仅作辅助证据；请先运行“合并当前已验证精读单元”，再审核主笔记");
      return;
    }
    if (!file || !(file.path.startsWith("wiki/papers/") || file.path.startsWith("wiki/experiments/"))) {
      new Notice("请先打开 wiki/papers 或 wiki/experiments 中的草稿笔记");
      return;
    }

    return this.withLock(true, "已审核知识整合", async (onProgress) => {
      // The runner verifies the same content fingerprint as the chat review UI.
      // This command must never turn an unreviewed draft into a reviewed source.
      await this.runPipeline(["integrate", "--note", file.path], undefined, onProgress);
    }, { progress: true });
  }

  async retryFailed() {
    return this.withLock(true, "失败任务重试", async () => {
      await this.runPipeline(["retry-failed"]);
      await this.runPipeline(["ingest-next"]);
    });
  }

  async runLint(showNotice) {
    return this.withLock(showNotice, "知识库健康检查", async () => {
      await this.runPipeline(["lint"]);
      this.pluginData.lastLintAt = Date.now();
      await this.saveData(this.pluginData);
    });
  }

  async maybeRunWeeklyLint() {
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - Number(this.pluginData.lastLintAt || 0) >= weekMs) {
      await this.runLint(false);
    }
  }

  async showKnowledgeMap() {
    return this.withLock(true, "知识关联与整理线索", async () => {
      const output = await this.runPipeline(["knowledge-map", "--report"], 30 * 1000);
      const payload = JSON.parse(output.trim());
      if (payload.report_path !== "system/reports/local-knowledge-map.md") {
        throw new Error("知识关联检查未返回预期的报告路径");
      }
      await this.app.workspace.openLinkText(payload.report_path, "", true);
    });
  }

  openEvidenceComparison() {
    const plugin = this;
    class EvidenceComparisonModal extends Modal {
      onOpen() {
        this.contentEl.createEl("h2", { text: "生成跨论文证据对比" });
        this.contentEl.createEl("p", { text: "输入需要比较的问题。报告保留各来源的证据、条件和审核状态。" });
        const input = this.contentEl.createEl("textarea", { attr: { rows: "4", "aria-label": "证据对比问题" } });
        input.style.width = "100%";
        const submit = this.contentEl.createEl("button", { text: "生成报告", cls: "mod-cta" });
        submit.type = "button";
        submit.addEventListener("click", async () => {
          const question = input.value.trim();
          if (!question) {
            new Notice("请输入要比较的问题");
            input.focus();
            return;
          }
          this.close();
          await plugin.compareEvidence(question);
        });
        input.focus();
      }

      onClose() {
        this.contentEl.empty();
      }
    }
    new EvidenceComparisonModal(this.app).open();
  }

  async compareEvidence(question) {
    const trimmed = String(question || "").trim();
    if (!trimmed) {
      new Notice("请输入要比较的问题");
      return;
    }
    const args = ["compare-evidence", "--question", trimmed];
    const file = this.app.workspace.getActiveFile();
    const experiment = file && /^wiki\/experiments\/(?!images\/|close-reading\/).+\.md$/.test(file.path)
      && !file.path.split("/").includes("..");
    if (this.isPrimaryPaper(file) || experiment) args.push("--note", file.path);
    args.push("--report");
    return this.openKnowledgeReport(args, "跨论文证据对比", "system/reports/evidence-comparison.md");
  }

  async openKnowledgeReport(args, label, expectedPath) {
    return this.withLock(true, label, async () => {
      const output = await this.runPipeline(args, 30 * 1000);
      const payload = JSON.parse(output.trim());
      if (payload.report_path !== expectedPath) {
        throw new Error(`${label}未返回预期的报告路径`);
      }
      await this.app.workspace.openLinkText(payload.report_path, "", true);
    });
  }

  async showQueueStatus() {
    try {
      const output = await this.runPipeline(["status"], 30 * 1000);
      const lines = output.trim().split("\n");
      const status = JSON.parse(lines[lines.length - 1]);
      const summary = Object.entries(status.counts || {})
        .map(([key, value]) => `${key}: ${value}`)
        .join("，");
      new Notice(summary || "知识任务队列为空", 8000);
    } catch (error) {
      console.error("[Knowledge Base] queue status", error);
      new Notice("无法读取知识任务队列");
    }
  }
};

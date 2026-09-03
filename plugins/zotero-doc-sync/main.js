const { Notice, Plugin } = require("obsidian");
const { execFile } = require("child_process");
const path = require("path");

module.exports = class ZoteroDocSyncPlugin extends Plugin {
  async onload() {
    this.busy = false;
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
      name: "审核通过并整合当前知识笔记",
      callback: () => this.approveAndIntegrateCurrent(),
    });

    this.addCommand({
      id: "retry-failed-knowledge-task",
      name: "重试最早的失败知识任务",
      callback: () => this.retryFailed(),
    });

    this.addCommand({
      id: "run-wiki-health-check",
      name: "运行知识库健康检查",
      callback: () => this.runLint(true),
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
      this.runIntensiveReadingAction("submit-initial", "提交初始理解");
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

    this.registerInterval(window.setInterval(() => this.runCycle(false), 60 * 1000));
    this.registerInterval(window.setInterval(() => this.maybeRunWeeklyLint(), 6 * 60 * 60 * 1000));

    window.setTimeout(() => this.runCycle(false), 3000);
    window.setTimeout(() => this.maybeRunWeeklyLint(), 15000);
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
    return Boolean(file && /^wiki\/papers\/[^/]+\.md$/.test(file.path));
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
    this.submitButton.textContent = this.busy ? "处理中…" : `提交 ${unit} 初始理解`;
    this.submitButton.disabled = this.busy;
    this.submitButton.setAttribute("aria-busy", this.busy ? "true" : "false");
    this.submitButton.setAttribute("aria-label", `提交 ${unit} 的初始理解`);
  }

  progressNotice(label) {
    const notice = new Notice("", 0);
    const root = notice.noticeEl;
    root.replaceChildren();
    root.addClass("kb-progress-notice");
    const header = root.createDiv({ cls: "kb-progress-header" });
    const title = header.createSpan({ cls: "kb-progress-title", text: label });
    const percent = header.createSpan({ cls: "kb-progress-percent", text: "0%" });
    const progress = root.createEl("progress", { cls: "kb-progress-track" });
    progress.max = 100;
    progress.value = 0;
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    progress.setAttribute("aria-valuenow", "0");
    const status = root.createDiv({ cls: "kb-progress-status", text: "正在启动…" });
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    title.setAttribute("aria-hidden", "true");
    percent.setAttribute("aria-hidden", "true");

    const update = (event) => {
      const value = Math.max(0, Math.min(100, Number(event?.percent || 0)));
      progress.value = value;
      progress.setAttribute("aria-valuenow", String(value));
      percent.textContent = `${value}%`;
      status.textContent = String(event?.message || "正在处理…");
      progress.setAttribute("aria-label", `${label}：${status.textContent}，${value}%`);
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
      if (typeof event.percent !== "number") return null;
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

  runPipeline(args, timeoutMs = 20 * 60 * 1000, onProgress) {
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
    if (showNotice && !reporter) new Notice(`${label}已开始`);
    try {
      await operation(reporter?.update);
      if (reporter) reporter.complete(`${label}已完成`);
      else if (showNotice) new Notice(`${label}已完成`);
    } catch (error) {
      console.error(`[Knowledge Base] ${label}`, error);
      if (reporter) reporter.fail();
      if (showNotice) {
        new Notice(`${label}失败：${this.errorDetail(error)}`, 10000);
      }
    } finally {
      this.busy = false;
      this.refreshSubmitControl();
    }
  }

  async runCycle(showNotice) {
    return this.withLock(showNotice, "同步和知识处理", async () => {
      try {
        await this.execPython(this.syncScript, [], 5 * 60 * 1000);
      } catch (error) {
        console.warn("[Knowledge Base] Zotero sync unavailable; continuing queued knowledge work", error);
      }
      await this.runPipeline(["ingest-next"]);
    });
  }

  async processNext(showNotice) {
    return this.withLock(showNotice, "知识笔记生成", async () => {
      await this.runPipeline(["scan"]);
      await this.runPipeline(["ingest-next"]);
    });
  }

  intensiveReadingContext(file = this.app.workspace.getActiveFile()) {
    if (!file) return null;
    if (/^wiki\/papers\/[^/]+\.md$/.test(file.path)) {
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
    if (!primary || !/^wiki\/papers\/[^/]+\.md$/.test(primary.path)) return null;
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

    return this.withLock(true, "审核与知识整合", async () => {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        if (frontmatter.status !== "draft" && frontmatter.status !== "reviewed") {
          throw new Error("当前笔记不是待审核草稿");
        }
        frontmatter.status = "reviewed";
        frontmatter.reviewed = true;
        frontmatter.reviewed_at = new Date().toISOString();
      });
      await this.runPipeline(["integrate", "--note", file.path]);
    });
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

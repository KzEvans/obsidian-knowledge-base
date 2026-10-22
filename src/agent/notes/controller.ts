import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MarkdownView, Modal, Notice, TFile } from 'obsidian';
import type { App, TAbstractFile, WorkspaceLeaf } from 'obsidian';
import type { ModuleContext } from '../../core/module';
import { errorMessage } from '../../core/secrets';
import { PAPER_NOTE_SKILL } from '../../../skills/paper-note/index';
import { lintNote } from '../../../skills/paper-note/lint';
import type { LintResult } from '../../../skills/paper-note/lint';
import { currentAgent } from '../runner';
import type { AgentSettings } from '../settings';
import { isReviewed, setReviewStatus } from './frontmatter';
import { generateNote } from './generate';
import type { GenerateResult } from './generate';
import { PAPERS_ROOT } from './metadata';
import { vaultNoteFiles } from './vault-files';

interface Job { sha: string; label: string }

/** Manual note generation (one or many papers, strictly one at a time), status toggle and lint. */
export class NoteController {
  private queue: Job[] = [];
  private running?: { job: Job; controller: AbortController };
  private notice?: Notice;

  constructor(private readonly context: ModuleContext<AgentSettings>) {}

  get app(): App { return this.context.app; }

  /** The stored paper behind a PDF or a paper note. */
  async paperFor(file: TFile): Promise<string | undefined> {
    if (file.extension.toLowerCase() === 'pdf') return this.context.store.shaForPath(file.path);
    if (file.extension !== 'md') return undefined;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (typeof frontmatter?.source_sha256 === 'string' && /^[0-9a-f]{64}$/.test(frontmatter.source_sha256)) return frontmatter.source_sha256;
    const link = typeof frontmatter?.source_pdf === 'string' ? frontmatter.source_pdf.replace(/^\[\[|\]\]$/g, '').split(/[|#]/)[0]!.trim() : '';
    const pdf = link ? this.app.metadataCache.getFirstLinkpathDest(link, file.path) : null;
    return pdf ? this.context.store.shaForPath(pdf.path) : undefined;
  }

  existingNote(sha: string, attachmentKey: string): string | undefined {
    return this.app.vault.getMarkdownFiles().find(file => {
      if (!file.path.startsWith(PAPERS_ROOT + '/')) return false;
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (frontmatter?.type !== 'paper') return false;
      return frontmatter.source_sha256 === sha || (!!attachmentKey && frontmatter.zotero_attachment === attachmentKey);
    })?.path;
  }

  /** Single paper from a PDF, the reading mode or a note. Regenerating asks first. */
  async generateFor(file: TFile): Promise<void> {
    const sha = await this.paperFor(file);
    if (!sha) { new Notice('没有找到这篇笔记或 PDF 对应的已解析论文。'); return; }
    const manifest = await this.context.store.manifest(sha);
    if (manifest?.stage !== 'ready') { new Notice(`这篇论文还没有就绪（当前：${manifest?.stage ?? '未处理'}），就绪后才能生成笔记。`); return; }
    const attachment = manifest.sources.find(source => source.zoteroAttachmentKey)?.zoteroAttachmentKey ?? '';
    const existing = this.existingNote(sha, attachment);
    if (existing && !await confirm(this.app, '重新生成笔记', `“${path.posix.basename(existing, '.md')}”已有笔记。重新生成会替换正文，保留“人工复核”“提问”、user-notes 和精读块。是否继续？`)) return;
    this.enqueue([{ sha, label: existing ? path.posix.basename(existing, '.md') : file.basename }]);
  }

  /** Several papers from the file explorer: only papers that are ready and have no note yet. */
  async generateForMany(files: TFile[]): Promise<void> {
    const jobs: Job[] = [];
    let skippedExisting = 0;
    let skippedNotReady = 0;
    const seen = new Set<string>();
    for (const file of files) {
      const sha = await this.paperFor(file);
      if (!sha || seen.has(sha)) continue;
      seen.add(sha);
      const manifest = await this.context.store.manifest(sha);
      if (manifest?.stage !== 'ready') { skippedNotReady += 1; continue; }
      const attachment = manifest.sources.find(source => source.zoteroAttachmentKey)?.zoteroAttachmentKey ?? '';
      if (this.existingNote(sha, attachment)) { skippedExisting += 1; continue; }
      jobs.push({ sha, label: file.basename });
    }
    const skipped = [skippedExisting ? `${skippedExisting} 篇已有笔记（多选不重写，请单独重新生成）` : '', skippedNotReady ? `${skippedNotReady} 篇尚未就绪` : ''].filter(Boolean).join('，');
    if (!jobs.length) { new Notice(skipped ? `没有需要生成的论文：${skipped}。` : '选中的文件里没有已解析的论文。'); return; }
    if (!await confirm(this.app, '生成笔记', `将依次为 ${jobs.length} 篇论文生成笔记${skipped ? `（跳过：${skipped}）` : ''}。是否继续？`)) return;
    this.enqueue(jobs);
  }

  stop(): void {
    const count = this.queue.length + (this.running ? 1 : 0);
    this.queue = [];
    this.running?.controller.abort();
    new Notice(count ? '已停止笔记生成。' : '没有正在生成的笔记。');
  }

  dispose(): void {
    this.queue = [];
    this.running?.controller.abort();
    this.notice?.hide();
  }

  private enqueue(jobs: Job[]): void {
    for (const job of jobs) {
      if (this.running?.job.sha === job.sha || this.queue.some(queued => queued.sha === job.sha)) continue;
      this.queue.push(job);
    }
    if (this.running) { new Notice(`已加入队列，前面还有 ${this.queue.length - 1} 篇。`); return; }
    void this.drain();
  }

  private async drain(): Promise<void> {
    let done = 0;
    while (this.queue.length) {
      const job = this.queue.shift()!;
      const controller = new AbortController();
      this.running = { job, controller };
      const total = done + 1 + this.queue.length;
      const prefix = total > 1 ? `生成笔记 ${done + 1}/${total}：` : '生成笔记：';
      this.status(`${prefix}${job.label}`);
      try {
        const result = await generateNote(job.sha, this.deps(), controller.signal, message => this.status(`${prefix}${job.label}\n${message}`));
        this.context.events.emit('note:generated', { notePath: result.notePath, sha: job.sha, conflict: result.conflict });
        this.report(job, result);
      } catch (error) {
        if (!controller.signal.aborted) new Notice(`生成失败（${job.label}）：${errorMessage(error)}`, 15_000);
        this.context.log.warn(`生成笔记失败：${job.sha.slice(0, 12)}`, error);
      } finally {
        this.running = undefined;
      }
      done += 1;
    }
    this.notice?.hide();
    this.notice = undefined;
  }

  private deps() {
    const { app, store, vaultPath, pluginDir, settings } = this.context;
    return {
      store,
      files: vaultNoteFiles(app),
      readVaultText: async (vaultPath: string) => {
        const file = app.vault.getAbstractFileByPath(vaultPath);
        if (file instanceof TFile) return app.vault.cachedRead(file);
        try { return await app.vault.adapter.read(vaultPath); } catch { return null; }
      },
      markdownPaths: () => app.vault.getMarkdownFiles().map(file => file.path).filter(file => file.startsWith('wiki/')).sort(),
      findExistingNote: (sha: string, attachment: string) => this.existingNote(sha, attachment),
      agent: () => currentAgent(settings),
      vaultPath,
      timeoutMs: settings.generationTimeoutMinutes * 60_000,
      skill: PAPER_NOTE_SKILL,
      saveCandidate: async (fileName: string, text: string) => {
        const target = path.join(pluginDir, 'candidates', fileName);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, text);
        return target;
      },
      now: () => new Date(),
    };
  }

  private status(message: string): void {
    if (!this.notice) this.notice = new Notice(message, 0);
    else this.notice.setMessage(message);
  }

  private report(job: Job, result: GenerateResult): void {
    if (result.conflict) {
      new Notice(`“${path.posix.basename(result.notePath, '.md')}”在生成期间被修改，没有覆盖。候选稿保存在：${result.candidatePath}`, 0);
      return;
    }
    const abstract = result.abstractFilled ? '' : '；摘要译文缺失，已保留占位标记';
    new Notice(`笔记已生成：${path.posix.basename(result.notePath, '.md')}（检查：${result.lint.ok ? '通过' : `${result.lint.problems.length} 个问题`}${abstract}）`, 10_000);
    if (!result.lint.ok) new LintModal(this.app, job.label, result.lint).open();
  }

  /** 检查当前笔记: lint only, no model. */
  async checkNote(file: TFile): Promise<void> {
    const lint = lintNote(await this.app.vault.read(file));
    if (lint.ok) new Notice(`检查通过（正文 ${lint.length} 字）。`);
    else new LintModal(this.app, file.basename, lint).open();
  }

  /** draft ⇄ reviewed on a paper note; writes `status` and `reviewed` together. */
  async toggleStatus(file: TFile): Promise<boolean> {
    let reviewed = false;
    await this.app.vault.process(file, data => {
      reviewed = !isReviewed(data);
      return setReviewStatus(data, reviewed);
    });
    new Notice(reviewed ? '已标记为已审核（reviewed）。' : '已改回草稿（draft）。');
    return reviewed;
  }

  isPaperNote(file: TFile | null): file is TFile {
    return !!file && file.extension === 'md' && this.app.metadataCache.getFileCache(file)?.frontmatter?.type === 'paper';
  }
}

export function fileOfLeaf(leaf: WorkspaceLeaf): TFile | null {
  const view = leaf.view as { file?: TAbstractFile | null };
  return view.file instanceof TFile ? view.file : null;
}

export function activeMarkdown(app: App): MarkdownView | null {
  return app.workspace.getActiveViewOfType(MarkdownView);
}

class LintModal extends Modal {
  constructor(app: App, private readonly name: string, private readonly lint: LintResult) { super(app); }

  override onOpen(): void {
    this.setTitle(`笔记检查：${this.name}`);
    this.contentEl.createEl('p', { text: `正文 ${this.lint.length} 字，${this.lint.problems.length} 个问题。` });
    const list = this.contentEl.createEl('ul', { cls: 'pw-lint-list' });
    for (const problem of this.lint.problems) {
      const where = [problem.section, problem.line ? `第 ${problem.line} 行` : ''].filter(Boolean).join(' · ');
      list.createEl('li', { text: `${where ? `[${where}] ` : ''}${problem.message}（${problem.rule}）` });
    }
  }

  override onClose(): void { this.contentEl.empty(); }
}

export function confirm(app: App, title: string, message: string): Promise<boolean> {
  return new Promise(resolve => {
    let answered = false;
    const modal = new class extends Modal {
      override onOpen(): void {
        this.setTitle(title);
        this.contentEl.createEl('p', { text: message });
        const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
        buttons.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
        buttons.createEl('button', { text: '继续', cls: 'mod-cta' }).addEventListener('click', () => { answered = true; this.close(); });
      }
      override onClose(): void { this.contentEl.empty(); resolve(answered); }
    }(app);
    modal.open();
  });
}

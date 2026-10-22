import { Modal, Notice } from 'obsidian';
import type { App } from 'obsidian';
import type { EventBus } from '../core/events';
import type { Stage } from '../core/types';
import type { PaperStatus, Pipeline } from './pipeline/pipeline';
import type { SyncStatus } from './scheduler';

export const STAGE_LABELS: Record<Stage, string> = {
  discovered: '已发现', copied: '等待解析', uploading: '上传中', parsing: '解析中', normalizing: '整理中',
  translating: '翻译中', ready: '就绪', failed: '失败', conflict: 'iCloud 冲突',
};

const PARSED: ReadonlySet<Stage> = new Set(['normalizing', 'translating', 'ready']);

/** `Zotero 14:05 · 解析 3/27 · 翻译 1/5 · 失败 1`, from memory only. */
export function statusText(sync: SyncStatus, papers: readonly PaperStatus[], paused: boolean): string {
  const parts: string[] = [];
  if (sync.state === 'running') parts.push('Zotero 同步中');
  else if (sync.state === 'failed') parts.push('Zotero 同步失败');
  else if (sync.state === 'ok' && sync.at) parts.push(`Zotero ${pad(sync.at.getHours())}:${pad(sync.at.getMinutes())}`);
  if (papers.length) {
    const parsed = papers.filter(paper => PARSED.has(paper.manifest.stage)).length;
    const translatable = papers.filter(paper => paper.manifest.stage === 'translating' || paper.manifest.stage === 'ready').length;
    const ready = papers.filter(paper => paper.manifest.stage === 'ready').length;
    parts.push(`解析 ${parsed}/${papers.length}`, `翻译 ${ready}/${translatable}`);
    const failed = papers.filter(paper => paper.manifest.stage === 'failed').length;
    const conflicts = papers.filter(paper => paper.manifest.stage === 'conflict').length;
    if (failed) parts.push(`失败 ${failed}`);
    if (conflicts) parts.push(`冲突 ${conflicts}`);
  }
  if (paused) parts.push('已暂停');
  return parts.join(' · ') || 'Paper Workbench';
}

function pad(value: number): string { return String(value).padStart(2, '0'); }

export function paperTitle(paper: PaperStatus): string {
  const path = paper.manifest.sources[0]?.path;
  return path ? path.split('/').pop()!.replace(/\.pdf$/i, '') : `${paper.manifest.sha256.slice(0, 12)}…（找不到 PDF）`;
}

const ORDER: Stage[] = ['conflict', 'failed', 'uploading', 'parsing', 'normalizing', 'translating', 'copied', 'discovered', 'ready'];

/** The list behind the status bar: pause, cancel, retry, prioritize, resolve conflicts. */
export class PipelinePanel extends Modal {
  private unsubscribe: Array<() => void> = [];
  private timer: number | undefined;

  constructor(app: App, private readonly pipeline: Pipeline, private readonly events: EventBus, private readonly setPaused: (paused: boolean) => Promise<void>) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle('Paper Workbench 流水线');
    this.modalEl.addClass('pw-pipeline-modal');
    const refresh = () => {
      if (this.timer !== undefined) return;
      this.timer = window.setTimeout(() => { this.timer = undefined; this.render(); }, 200);
    };
    for (const name of ['paper:stage-changed', 'paper:translation-progress', 'paper:parse-progress', 'paper:conflict', 'pipeline:paused'] as const) {
      this.unsubscribe.push(this.events.on(name, refresh));
    }
    this.render();
  }

  override onClose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const bar = contentEl.createDiv({ cls: 'pw-pipeline-bar' });
    const paused = this.pipeline.paused;
    bar.createSpan({ text: paused ? '已暂停：正在进行的步骤会做完，不再开始新的步骤。' : '运行中' });
    const toggle = bar.createEl('button', { text: paused ? '继续' : '全部暂停' });
    toggle.addEventListener('click', () => { void this.setPaused(!paused).then(() => this.render()); });

    const papers = this.pipeline.snapshot().sort((a, b) => ORDER.indexOf(a.manifest.stage) - ORDER.indexOf(b.manifest.stage) || paperTitle(a).localeCompare(paperTitle(b)));
    if (!papers.length) { contentEl.createEl('p', { text: '还没有论文进入流水线。', cls: 'pw-muted' }); return; }
    const list = contentEl.createDiv({ cls: 'pw-pipeline-list' });
    for (const paper of papers) {
      const { manifest } = paper;
      const row = list.createDiv({ cls: 'pw-pipeline-row' });
      const info = row.createDiv({ cls: 'pw-pipeline-info' });
      info.createDiv({ text: paperTitle(paper), cls: 'pw-pipeline-title' });
      const detail = info.createDiv({ cls: 'pw-muted' });
      let text = STAGE_LABELS[manifest.stage];
      if (manifest.stage === 'parsing' && paper.parse) text += ` ${paper.parse.done}/${paper.parse.total} 页`;
      if ((manifest.stage === 'translating' || manifest.stage === 'ready') && paper.translation) {
        text += ` · 译文 ${paper.translation.done}/${paper.translation.total}${paper.translation.failed ? `，${paper.translation.failed} 段失败` : ''}`;
      }
      if (manifest.priority && manifest.stage !== 'ready') text += ' · 优先';
      detail.setText(text);
      if (manifest.failure) info.createDiv({ text: `${STAGE_LABELS[manifest.failure.stage]}失败：${manifest.failure.error}`, cls: 'pw-pipeline-error' });
      if (paper.conflicts.length) info.createDiv({ text: `冲突副本：${paper.conflicts.join('、')}`, cls: 'pw-pipeline-error' });

      const actions = row.createDiv({ cls: 'pw-pipeline-actions' });
      const button = (label: string, run: () => void) => actions.createEl('button', { text: label }).addEventListener('click', run);
      if (manifest.stage === 'conflict') {
        button('保留当前版本', () => {
          new ConfirmModal(this.app, '保留当前版本？', `以下冲突副本会移到 .research/conflicts/，当前文件保持不变：\n${paper.conflicts.join('\n')}`, () => {
            void this.pipeline.keepCurrent(manifest.sha256).then(() => this.render(), (error: unknown) => new Notice(`处理冲突失败：${error instanceof Error ? error.message : String(error)}`));
          }).open();
        });
      } else if (manifest.stage === 'failed' || (manifest.stage === 'ready' && (manifest.translation?.failed ?? 0) > 0)) {
        button('重试', () => this.pipeline.retry(manifest.sha256));
      } else if (manifest.stage !== 'ready') {
        if (!manifest.priority) button('优先', () => this.pipeline.prioritize(manifest.sha256));
        button('取消', () => this.pipeline.cancel(manifest.sha256));
      }
    }
  }
}

export interface BacklogItem { sha: string; path: string; pages?: number }

/** First-run confirmation before any of the existing PDFs is sent to MinerU. */
export class BacklogModal extends Modal {
  private decided = false;

  constructor(app: App, private readonly items: readonly BacklogItem[], private readonly decide: (confirmed: boolean | null) => void) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle('处理文献库中已有的论文？');
    const pages = this.items.reduce((sum, item) => sum + (item.pages ?? 0), 0);
    const unknown = this.items.filter(item => item.pages === undefined).length;
    this.contentEl.createEl('p', { text: `共 ${this.items.length} 篇需要上传 MinerU 解析，预计 ${pages} 页${unknown ? `（另有 ${unknown} 篇页数未知）` : ''}。已有旧解析缓存的论文不计在内，也不会重新上传。` });
    const list = this.contentEl.createEl('ul', { cls: 'pw-backlog-list' });
    for (const item of this.items) list.createEl('li', { text: `${item.path.split('/').pop() ?? item.path}${item.pages === undefined ? '' : `（${item.pages} 页）`}` });
    this.contentEl.createEl('p', { text: '选择“以后再说”时，只有之后新加入的 PDF 会自动处理；可以随时在设置的“文献库”里补跑。', cls: 'pw-muted' });
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: '以后再说' }).addEventListener('click', () => this.finish(false));
    const start = buttons.createEl('button', { text: '开始处理', cls: 'mod-cta' });
    start.addEventListener('click', () => this.finish(true));
  }

  override onClose(): void {
    this.contentEl.empty();
    // Closing without a choice asks again next time.
    if (!this.decided) { this.decided = true; this.decide(null); }
  }

  private finish(confirmed: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.decide(confirmed);
    this.close();
  }
}

class ConfirmModal extends Modal {
  constructor(app: App, private readonly heading: string, private readonly message: string, private readonly onConfirm: () => void) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.heading);
    this.contentEl.createEl('p', { text: this.message, cls: 'pw-pre-line' });
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
    buttons.createEl('button', { text: '确认', cls: 'mod-cta' }).addEventListener('click', () => { this.close(); this.onConfirm(); });
  }

  override onClose(): void { this.contentEl.empty(); }
}

import type { Manifest, Stage, TranslationFile } from '../core/types';

export interface Progress { done: number; total: number; failed?: number }

/** What the reader knows about a paper it cannot (fully) show yet. */
export interface PaperStatus {
  manifest?: Manifest;
  /** Latest paper:parse-progress / paper:translation-progress payloads. */
  parse?: Progress;
  translation?: Progress;
  conflicts: string[];
  pipelineLoaded: boolean;
}

export type StatusAction = 'prioritize' | 'retry' | 'request';

export interface StatusView {
  title: string;
  detail?: string;
  /** 0–1 when known. */
  progress?: number;
  actions: StatusAction[];
  error: boolean;
}

const STAGE_LABELS: Record<Stage, string> = {
  discovered: '排队中', copied: '排队中', uploading: '解析中（上传）', parsing: '解析中', normalizing: '整理中',
  translating: '翻译中', ready: '已就绪', failed: '处理失败', conflict: '存储冲突',
};

export function stageLabel(stage: Stage): string {
  return STAGE_LABELS[stage];
}

/** Status panel for a paper whose document.json is not there yet. */
export function describeStatus(status: PaperStatus): StatusView {
  const { manifest } = status;
  const missingPipeline = status.pipelineLoaded ? undefined : '文献库模块未加载，无法排队或重试。';
  if (!manifest) {
    return {
      title: '这篇 PDF 尚未解析',
      detail: missingPipeline ?? '处理会把 PDF 上传到 MinerU 云端解析并消耗额度，需要你确认。',
      actions: status.pipelineLoaded ? ['request'] : [],
      error: false,
    };
  }
  if (manifest.stage === 'failed' && manifest.failure) {
    const failure = manifest.failure;
    return {
      title: `${stageLabel(failure.stage)}阶段失败`,
      detail: [failure.error, `已尝试 ${failure.attempts} 次`, missingPipeline].filter(Boolean).join(' · '),
      actions: status.pipelineLoaded ? ['retry'] : [],
      error: true,
    };
  }
  if (manifest.stage === 'conflict') {
    return {
      title: '解析存储有 iCloud 冲突副本',
      detail: status.conflicts.length ? `冲突文件：${status.conflicts.join('、')}。请在文献库面板选择保留哪一份。` : '请在文献库面板选择保留哪一份。',
      actions: [],
      error: true,
    };
  }
  const progress = manifest.stage === 'parsing' || manifest.stage === 'uploading' ? status.parse
    : manifest.stage === 'translating' ? status.translation ?? manifest.translation : undefined;
  const detail = [
    progress && progress.total > 0 ? `${progress.done}/${progress.total}${manifest.stage === 'translating' ? ' 段' : ' 页'}` : undefined,
    manifest.priority ? '已优先' : undefined,
    missingPipeline,
  ].filter(Boolean).join(' · ');
  return {
    title: stageLabel(manifest.stage),
    ...(detail ? { detail } : {}),
    ...(progress && progress.total > 0 ? { progress: Math.min(1, progress.done / progress.total) } : {}),
    actions: status.pipelineLoaded && !manifest.priority && manifest.stage !== 'ready' ? ['prioritize'] : [],
    error: false,
  };
}

export const ACTION_LABELS: Record<StatusAction, string> = { prioritize: '优先处理这篇', retry: '重试', request: '处理这篇' };

/** Fill a status panel; handlers run for the action buttons and "继续原 PDF". */
export function renderStatus(container: HTMLElement, view: StatusView, handlers: { action(action: StatusAction): void; close(): void }): void {
  container.empty();
  container.toggleClass('is-error', view.error);
  container.setAttribute('role', view.error ? 'alert' : 'status');
  const text = container.createDiv({ cls: 'pw-reader-status-text' });
  text.createEl('strong', { text: view.title });
  if (view.detail) text.createSpan({ cls: 'pw-reader-status-detail', text: view.detail });
  if (view.progress !== undefined) {
    const bar = container.createEl('progress', { cls: 'pw-reader-status-progress' });
    bar.max = 1;
    bar.value = view.progress;
  }
  for (const action of view.actions) {
    container.createEl('button', { text: ACTION_LABELS[action], cls: 'mod-cta', attr: { 'data-action': action } })
      .addEventListener('click', () => handlers.action(action));
  }
  container.createEl('button', { text: '继续原 PDF' }).addEventListener('click', () => handlers.close());
}

export interface LanguageButtonView { enabled: boolean; text: string; title: string }

/** The Chinese toggle is greyed out until any translation exists and shows progress while translating. */
export function languageButton(language: 'en' | 'zh', manifest: Manifest | undefined, translations: TranslationFile | undefined, progress: Progress | undefined): LanguageButtonView {
  const entries = translations ? Object.keys(translations.entries).length : 0;
  const counts = progress ?? manifest?.translation;
  const translating = manifest?.stage === 'translating' && counts && counts.total > 0;
  const percent = translating ? ` ${Math.floor(100 * Math.min(1, counts.done / counts.total))}%` : '';
  if (!entries) {
    return { enabled: false, text: `中文${percent}`, title: translating ? `翻译进行中：${counts.done}/${counts.total} 段` : '全文翻译尚未开始' };
  }
  const text = language === 'zh' ? `English${percent}` : `中文${percent}`;
  const title = (language === 'zh' ? '切换到英文原文' : '切换到中文译文') + (translating ? `（翻译进行中：${counts.done}/${counts.total} 段）` : '');
  return { enabled: true, text, title };
}

/**
 * Language-switch shift acceptance (architecture §6.2), run inside Obsidian.
 * See tests/e2e/README.md for how to build and run it from the developer console.
 *
 * For each paper × view width × scroll position: read the distance from the viewport
 * top to the reader block there (and to the first visible bilingual block), switch to
 * Chinese, read again, switch back, read again. Every change must be ≤ 1 px and the
 * scroll position must not move. Also records the reader's open time, cold and cached.
 */
import type { App, WorkspaceLeaf } from 'obsidian';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { offsetOf, sampleDelta, scrollFractions, summarize, topOffset } from './shift-measure';
import type { PaperRun, ShiftSample, ShiftSummary } from './shift-measure';

export interface ShiftOptions {
  /** Vault paths of PDFs; default: the first three papers with a translation file. */
  papers?: string[];
  /** View widths in CSS px. */
  widths?: number[];
  /** Scroll positions per paper and width (at least 20). */
  positions?: number;
  /** Wait after the reader opens, for MathJax and images to settle. */
  settleMs?: number;
  /** Where the result JSON goes; default: the folder this bundle sits in (tests/e2e/results/). */
  outDir?: string;
  tolerancePx?: number;
}

const BLOCK = '.pdf-reader-block[data-reader-block-id]';
const LAYERED = '.pw-block';

export interface ShiftResult extends ShiftSummary {
  file: string;
  /** Largest shift per paper and width, for console.table(). */
  table: Array<{ paper: string; width: number; samples: number; maxDelta: number; error: string }>;
  timings: Array<{ paper: string; width: number; openMs: number; cached: boolean }>;
}

export async function run(app: App, options: ShiftOptions = {}): Promise<ShiftResult> {
  const widths = options.widths ?? [420, 600, 900];
  const fractions = scrollFractions(Math.max(20, options.positions ?? 24));
  const settleMs = options.settleMs ?? 1500;
  const papers = options.papers ?? await translatedPapers(app, 3);
  if (!papers.length) throw new Error('没有找到带 translation.zh.json 的论文；用 options.papers 指定。');
  const runs: PaperRun[] = [];
  const timings: Array<{ paper: string; width: number; openMs: number; cached: boolean }> = [];
  for (const paperPath of papers) {
    const label = path.basename(paperPath);
    const file = app.vault.getFileByPath(paperPath);
    if (!file) { runs.push({ paper: label, width: 0, samples: [], error: '找不到文件' }); continue; }
    const leaf = app.workspace.getLeaf('tab');
    try {
      await leaf.openFile(file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      let opened = 0;
      for (const width of widths) {
        setWidth(leaf, width);
        await frames(2);
        try {
          const started = performance.now();
          const root = await openReader(leaf);
          timings.push({ paper: label, width, openMs: Math.round(performance.now() - started), cached: opened++ > 0 });
          await sleep(settleMs);
          runs.push({ paper: label, width, samples: await measure(root, leaf, fractions) });
        } catch (error) {
          runs.push({ paper: label, width, samples: [], error: error instanceof Error ? error.message : String(error) });
        } finally {
          await closeReader(leaf);
        }
      }
    } finally {
      leaf.detach();
    }
  }
  const summary = summarize(runs, options.tolerancePx ?? 1);
  const outDir = options.outDir ?? __dirname;
  await fs.mkdir(outDir, { recursive: true });
  const fileName = path.join(outDir, `shift-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(fileName, JSON.stringify({ at: new Date().toISOString(), options: { widths, positions: fractions.length, settleMs }, summary, timings, runs }, null, 2) + '\n');
  const table = runs.map(run => ({ paper: run.paper, width: run.width, samples: run.samples.length, maxDelta: Math.max(0, ...run.samples.map(sample => sample.delta)), error: run.error ?? '' }));
  return { ...summary, file: fileName, table, timings };
}

async function measure(root: HTMLElement, leaf: WorkspaceLeaf, fractions: number[]): Promise<ShiftSample[]> {
  const toggle = leaf.view.containerEl.querySelector<HTMLButtonElement>('.pw-reader-language');
  if (!toggle || toggle.disabled) throw new Error('这篇还没有译文，中文切换不可用');
  if (root.dataset.lang !== 'en') { toggle.click(); await frames(2); }
  const blockId = (element: HTMLElement) => element.dataset.readerBlockId ?? '';
  const layerId = (element: HTMLElement) => `${element.closest<HTMLElement>(BLOCK)?.dataset.readerBlockId ?? ''}:${Array.from(element.closest(BLOCK)?.querySelectorAll(LAYERED) ?? []).indexOf(element)}`;
  const samples: ShiftSample[] = [];
  for (const fraction of fractions) {
    root.scrollTop = Math.round(fraction * Math.max(0, root.scrollHeight - root.clientHeight));
    await frames(2);
    const scrollTop = root.scrollTop;
    const block = topOffset(root, BLOCK, blockId);
    const layer = topOffset(root, LAYERED, layerId);
    const read = () => [
      block ? offsetOf(root, BLOCK, blockId, block.id) ?? NaN : 0,
      layer ? offsetOf(root, LAYERED, layerId, layer.id) ?? NaN : 0,
    ];
    const en = read();
    toggle.click();
    await frames(2);
    if (root.dataset.lang !== 'zh') throw new Error('切换到中文没有生效');
    const zh = read();
    const zhScroll = root.scrollTop;
    toggle.click();
    await frames(2);
    const back = read();
    samples.push({
      fraction, scrollTop, ...(block ? { block: block.id } : {}), ...(layer ? { layer: layer.id } : {}),
      en, zh, back, scrollChanged: zhScroll !== scrollTop || root.scrollTop !== scrollTop, delta: sampleDelta(en, zh, back),
    });
  }
  return samples;
}

async function openReader(leaf: WorkspaceLeaf): Promise<HTMLElement> {
  const container = leaf.view.containerEl;
  const button = await waitFor(() => container.querySelector<HTMLElement>('[data-pw-button="reader-mode"]'), 10_000, '找不到阅读模式按钮');
  button.click();
  return waitFor(() => container.querySelector<HTMLElement>('.pdf-reader-content[data-pdf-reader-active="true"]'), 120_000, '阅读模式没有打开（可能尚未解析完成）');
}

async function closeReader(leaf: WorkspaceLeaf): Promise<void> {
  const container = leaf.view.containerEl;
  if (container.querySelector('.pdf-reader-content[data-pdf-reader-active="true"]')) container.querySelector<HTMLElement>('[data-pw-button="reader-mode"]')?.click();
  await frames(2);
}

function setWidth(leaf: WorkspaceLeaf, width: number): void {
  leaf.view.containerEl.style.width = `${width}px`;
  leaf.view.containerEl.style.maxWidth = `${width}px`;
}

/** Papers whose parse store has a translation file, from the store's path index. */
async function translatedPapers(app: App, count: number): Promise<string[]> {
  const adapter = app.vault.adapter;
  const index = JSON.parse(await adapter.read('.research/index.json')) as { paths: Record<string, string> };
  const found: string[] = [];
  const seen = new Set<string>();
  for (const [vaultPath, sha] of Object.entries(index.paths)) {
    if (seen.has(sha) || !app.vault.getFileByPath(vaultPath)) continue;
    seen.add(sha);
    if (await adapter.exists(`.research/papers/${sha}/translation.zh.json`)) found.push(vaultPath);
    if (found.length >= count) break;
  }
  return found;
}

async function waitFor<T>(probe: () => T | null | undefined, timeoutMs: number, message: string): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(message);
    await sleep(100);
  }
}

function frames(count: number): Promise<void> {
  return new Promise(resolve => {
    const step = (left: number) => left <= 0 ? resolve() : window.requestAnimationFrame(() => step(left - 1));
    step(count);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

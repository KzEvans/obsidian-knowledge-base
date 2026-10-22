/** Pure parts of the language-switch shift check (architecture §6.2), unit-tested in Node. */

export interface TopOffset { id: string; offset: number }

export interface ShiftSample {
  fraction: number;
  scrollTop: number;
  /** Viewport-top reader block and the first visible bilingual block inside the viewport. */
  block?: string;
  layer?: string;
  /** Distances to the viewport top: English, after switching to Chinese, after switching back. */
  en: number[];
  zh: number[];
  back: number[];
  scrollChanged: boolean;
  delta: number;
}

export interface PaperRun { paper: string; width: number; samples: ShiftSample[]; error?: string }

export interface ShiftSummary {
  pass: boolean;
  tolerancePx: number;
  papers: number;
  widths: number[];
  samples: number;
  maxDeltaPx: number;
  failures: Array<{ paper: string; width: number; fraction: number; block?: string; delta: number; scrollChanged: boolean }>;
  errors: Array<{ paper: string; width: number; error: string }>;
}

/** Evenly spaced scroll positions from top (0) to bottom (1). */
export function scrollFractions(count: number): number[] {
  if (count < 2) return [0];
  return Array.from({ length: count }, (_, index) => Math.round(index / (count - 1) * 10_000) / 10_000);
}

/**
 * The first element matching `selector`, in document order, that reaches below the
 * viewport top; its distance to the viewport top (negative when it starts above).
 */
export function topOffset(root: HTMLElement, selector: string, idOf: (element: HTMLElement) => string): TopOffset | undefined {
  const top = root.getBoundingClientRect().top;
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= top + 0.5) continue;
    return { id: idOf(element), offset: rect.top - top };
  }
  return undefined;
}

/** Offset of a specific element (by id) after switching; undefined if it vanished. */
export function offsetOf(root: HTMLElement, selector: string, idOf: (element: HTMLElement) => string, id: string): number | undefined {
  const top = root.getBoundingClientRect().top;
  const element = Array.from(root.querySelectorAll<HTMLElement>(selector)).find(candidate => idOf(candidate) === id);
  return element ? element.getBoundingClientRect().top - top : undefined;
}

/** Largest movement of any tracked element across the switch and the switch back. */
export function sampleDelta(en: number[], zh: number[], back: number[]): number {
  let delta = 0;
  en.forEach((before, index) => {
    for (const after of [zh[index], back[index]]) delta = Math.max(delta, after === undefined || !Number.isFinite(after) ? Infinity : Math.abs(after - before));
  });
  return Math.round(delta * 100) / 100;
}

export function summarize(runs: readonly PaperRun[], tolerancePx = 1): ShiftSummary {
  const samples = runs.flatMap(run => run.samples.map(sample => ({ run, sample })));
  const failures = samples.filter(({ sample }) => sample.delta > tolerancePx || sample.scrollChanged)
    .map(({ run, sample }) => ({ paper: run.paper, width: run.width, fraction: sample.fraction, ...(sample.block ? { block: sample.block } : {}), delta: sample.delta, scrollChanged: sample.scrollChanged }));
  const errors = runs.filter(run => run.error).map(run => ({ paper: run.paper, width: run.width, error: run.error! }));
  return {
    pass: failures.length === 0 && errors.length === 0 && samples.length > 0,
    tolerancePx,
    papers: new Set(runs.map(run => run.paper)).size,
    widths: [...new Set(runs.map(run => run.width))],
    samples: samples.length,
    maxDeltaPx: samples.reduce((max, { sample }) => Math.max(max, sample.delta), 0),
    failures,
    errors,
  };
}

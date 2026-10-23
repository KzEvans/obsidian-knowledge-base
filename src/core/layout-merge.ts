/**
 * MinerU joins a paragraph that continues in the next column or on the next page
 * into the earlier block and marks the later block `lines_deleted` in layout.json.
 * The content list keeps that later block with empty text. These are the indices of
 * such blocks, so normalization can attach their source regions to the paragraph
 * that already holds the text instead of treating them as missing text.
 */

type Box = [number, number, number, number];

interface LayoutBlock { type?: unknown; bbox?: unknown; lines_deleted?: unknown }
interface LayoutPage { page_idx?: unknown; page_size?: unknown; para_blocks?: unknown }

/** Content-list boxes use 0–1000 page units; layout boxes use PDF points. */
const MATCH_TOLERANCE = 6;

export function mergedIntoPrevious(layout: unknown, items: readonly unknown[]): Set<number> {
  const result = new Set<number>();
  const pages = (layout as { pdf_info?: unknown } | null)?.pdf_info;
  if (!Array.isArray(pages)) return result;

  const emptyByPage = new Map<number, Array<{ index: number; box: Box }>>();
  items.forEach((raw, index) => {
    const item = raw as { type?: unknown; text?: unknown; page_idx?: unknown; bbox?: unknown } | null;
    if (!item || item.type !== 'text' || typeof item.page_idx !== 'number') return;
    if (typeof item.text === 'string' && item.text.trim()) return;
    const box = asBox(item.bbox);
    if (!box) return;
    const list = emptyByPage.get(item.page_idx) ?? [];
    list.push({ index, box });
    emptyByPage.set(item.page_idx, list);
  });

  for (const rawPage of pages as LayoutPage[]) {
    const pageIndex = rawPage?.page_idx;
    const size = rawPage?.page_size;
    if (typeof pageIndex !== 'number' || !Array.isArray(size) || !Array.isArray(rawPage.para_blocks)) continue;
    const [width, height] = size as unknown[];
    if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) continue;
    const candidates = emptyByPage.get(pageIndex);
    if (!candidates?.length) continue;
    for (const block of rawPage.para_blocks as LayoutBlock[]) {
      if (block?.lines_deleted !== true || block.type !== 'text') continue;
      const points = asBox(block.bbox);
      if (!points) continue;
      const scaled: Box = [points[0] / width * 1000, points[1] / height * 1000, points[2] / width * 1000, points[3] / height * 1000];
      const match = candidates.find(candidate => !result.has(candidate.index) &&
        candidate.box.every((value, axis) => Math.abs(value - scaled[axis]!) <= MATCH_TOLERANCE));
      if (match) result.add(match.index);
    }
  }
  return result;
}

function asBox(value: unknown): Box | undefined {
  return Array.isArray(value) && value.length === 4 && value.every(entry => typeof entry === 'number' && Number.isFinite(entry))
    ? value as Box
    : undefined;
}

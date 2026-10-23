import { auditNativeText } from './audit';
import type { AuditPdf } from './audit';
import { normalizeSegmentText, segmentHash } from './hash';
import { dimensionsFromHeader } from './image-size';
import { contentListName } from './mineru';
import { mergedIntoPrevious } from './layout-merge';
import { normalizeContentList } from './normalize';
import type { ReaderBlock, Segment, StoredAsset, StoredBlock, StoredDocument } from './types';

/**
 * Bump whenever normalize, audit, crop or segment rules change. Stored documents
 * with an older version are rebuilt offline from raw/ — never re-uploaded.
 */
export const NORMALIZER_VERSION = 2;

export const TABLE_CROP_DIR = 'source-tables-v1';
export const FALLBACK_CROP_DIR = 'fallback-v2';

export interface RawFiles {
  names: string[];
  read(name: string): Promise<Uint8Array>;
}

export interface CropRequest {
  blockId: string;
  /** Path under derived/. */
  asset: string;
  kind: 'figure' | 'table' | 'equation';
  bbox: [number, number, number, number];
  /** Selectable caption regions painted white inside a figure crop. */
  masks: Array<[number, number, number, number]>;
}

export interface CropResult { png: Uint8Array; width: number; height: number }

/** Renders source-page crops; the Obsidian implementation uses pdf.js and a canvas (crop-canvas.ts). */
export interface Cropper {
  cropPage(pageNumber: number, requests: CropRequest[]): Promise<Map<string, CropResult>>;
}

export interface DeriveInput {
  sha: string;
  raw: RawFiles;
  pdf: AuditPdf;
  cropper: Cropper;
  /** Crops that already exist under derived/ (from an earlier run); they are reused, not redrawn. */
  existingDerived?: (asset: string) => Promise<Uint8Array | undefined>;
}

export interface DeriveOutput {
  document: StoredDocument;
  /** New files to write under derived/, keyed by their path there. */
  derived: Record<string, Uint8Array>;
}

export async function derive(input: DeriveInput): Promise<DeriveOutput> {
  const listName = contentListName(input.raw.names);
  if (!listName) throw new Error('原始结果中没有唯一的 content_list.json。');
  const items: unknown = JSON.parse(new TextDecoder().decode(await input.raw.read(listName)));
  const layoutName = input.raw.names.find(name => name === 'layout.json' || name.endsWith('/layout.json'));
  const layout: unknown = layoutName ? JSON.parse(new TextDecoder().decode(await input.raw.read(layoutName))) : undefined;
  const reader = normalizeContentList(items, input.sha, `normalizer-v${NORMALIZER_VERSION}`, input.pdf.numPages, {
    mergedIntoPrevious: Array.isArray(items) ? mergedIntoPrevious(layout, items) : undefined,
  });

  const contentBase = listName.includes('/') ? listName.slice(0, listName.lastIndexOf('/')) : '.';
  const assets: Record<string, StoredAsset> = {};
  for (const block of reader.blocks) {
    if (!block.asset) continue;
    const resolved = resolveAssetReference(block.asset, contentBase, input.raw.names);
    if (!resolved) {
      reader.warnings.push(`第 ${block.sources[0]?.page ?? '?'} 页图片资源缺失，请核对原页。`);
      delete block.asset;
      continue;
    }
    block.asset = resolved;
    assets[resolved] ??= { path: `raw/${resolved}`, ...dimensionsFromHeader(await input.raw.read(resolved)) };
  }

  await auditNativeText(input.pdf, reader);

  const derived: Record<string, Uint8Array> = {};
  const plan = planCrops(reader.blocks);
  for (const [page, requests] of plan) {
    const pending: CropRequest[] = [];
    for (const request of requests) {
      const existing = await input.existingDerived?.(request.asset);
      const size = existing && dimensionsFromHeader(existing);
      if (size) assets[request.asset] = { path: `derived/${request.asset}`, ...size };
      else pending.push(request);
    }
    if (!pending.length) continue;
    const results = await input.cropper.cropPage(page, pending);
    for (const request of pending) {
      const result = results.get(request.blockId);
      if (!result) throw new Error(`第 ${page} 页原文图表裁切失败。`);
      derived[request.asset] = result.png;
      assets[request.asset] = { path: `derived/${request.asset}`, width: result.width, height: result.height };
    }
  }
  for (const requests of plan.values()) {
    for (const request of requests) reader.blocks.find(block => block.id === request.blockId)!.asset = request.asset;
  }

  const blocks = markAbstract(reader.blocks.map(toStoredBlock));
  return {
    document: {
      schemaVersion: 2,
      sha256: input.sha,
      normalizerVersion: NORMALIZER_VERSION,
      pageCount: reader.pageCount,
      blocks,
      warnings: [...new Set(reader.warnings)],
      assets,
    },
    derived,
  };
}

/**
 * Tables always use an original-PDF crop (provider table HTML is not shown).
 * Figures and equations are cropped only when the provider gave no image.
 */
export function planCrops(blocks: readonly ReaderBlock[]): Map<number, CropRequest[]> {
  const pages = new Map<number, CropRequest[]>();
  for (const block of blocks) {
    const source = block.sources[0];
    if (!source?.bbox) continue;
    const isTable = block.kind === 'table';
    if (!isTable && !((block.kind === 'figure' || block.kind === 'equation') && !block.asset)) continue;
    const request: CropRequest = {
      blockId: block.id,
      asset: `${isTable ? TABLE_CROP_DIR : FALLBACK_CROP_DIR}/${block.id}.png`,
      kind: block.kind as CropRequest['kind'],
      bbox: source.bbox,
      masks: block.kind === 'figure'
        ? block.sources.slice(1).filter(caption => caption.page === source.page && caption.bbox).map(caption => caption.bbox!)
        : [],
    };
    const list = pages.get(source.page) ?? [];
    list.push(request);
    pages.set(source.page, list);
  }
  return pages;
}

/** Crop rectangle in page fractions, padded in PDF points as the old reader did. */
export function cropBox(request: CropRequest, pageWidthPt: number, pageHeightPt: number): [number, number, number, number] {
  const table = request.kind === 'table';
  const padding = table ? 2 : 10;
  const padX = padding / pageWidthPt, padY = padding / pageHeightPt;
  const bottomPadY = (table ? 4 : 10) / pageHeightPt;
  const [x0, y0, x1, y1] = request.bbox;
  return [Math.max(0, x0 - padX), Math.max(0, y0 - (table ? 0 : padY)), Math.min(1, x1 + padX), Math.min(1, y1 + bottomPadY)];
}

/** A provider image reference, either archive-relative or relative to the content list's folder. */
export function resolveAssetReference(reference: string, contentBase: string, names: readonly string[]): string | undefined {
  if (!reference || /^(?:[a-z]+:|\/|\\)/i.test(reference)) return undefined;
  const normalized = reference.replace(/\\/g, '/');
  const candidates = [posixNormalize(normalized), posixNormalize(contentBase === '.' ? normalized : `${contentBase}/${normalized}`)];
  return candidates.find(candidate => !candidate.startsWith('../') && candidate !== '..' && names.includes(candidate));
}

const TRANSLATABLE_TEXT = new Set<ReaderBlock['kind']>(['paragraph', 'heading', 'list', 'footnote']);
const TRANSLATABLE_CAPTIONS = new Set<ReaderBlock['kind']>(['figure', 'table', 'equation']);

/** Which strings of a block get translated (contracts §3). References, metadata and formulas never do. */
export function toStoredBlock(block: ReaderBlock): StoredBlock {
  const segments: Segment[] = [];
  const add = (field: Segment['field'], index: number, text: string | undefined) => {
    if (text && normalizeSegmentText(text) && /\p{L}/u.test(text.replace(/\$[^$]*\$/g, ''))) segments.push({ field, index, sourceHash: segmentHash(text) });
  };
  if (!block.hiddenByDefault) {
    if (TRANSLATABLE_TEXT.has(block.kind)) add('text', 0, block.text);
    if (TRANSLATABLE_CAPTIONS.has(block.kind)) {
      block.captions?.forEach((caption, index) => add('caption', index, caption));
      block.footnotes?.forEach((footnote, index) => add('footnote', index, footnote));
    }
  }
  return { ...block, translatable: segments.length > 0, ...(segments.length ? { segments } : {}) };
}

const ABSTRACT_HEADING = /^(?:\d+[.)]?)?abstract[:.]?$/;
const ABSTRACT_LEAD = /^(?:abstract|a\s?b\s?s\s?t\s?r\s?a\s?c\s?t)\s*[:.—–-]\s*\S/i;
const MAX_ABSTRACT_PARAGRAPHS = 3;

/** Mark the abstract so the note's 摘要翻译 section can take its translation directly. */
export function markAbstract(blocks: StoredBlock[]): StoredBlock[] {
  const plain = (block: StoredBlock) => block.text.replace(/<[^>]*>/g, '').trim();
  const headingIndex = blocks.findIndex(block => block.kind === 'heading' && ABSTRACT_HEADING.test(plain(block).replace(/\s+/g, '').toLowerCase()));
  if (headingIndex >= 0) {
    let marked = 0;
    for (let index = headingIndex + 1; index < blocks.length && marked < MAX_ABSTRACT_PARAGRAPHS; index++) {
      const block = blocks[index]!;
      if (block.kind === 'heading') break;
      if (block.kind !== 'paragraph' || !block.translatable) continue;
      block.role = 'abstract';
      marked++;
    }
    if (marked) return blocks;
  }
  const lead = blocks.find(block => block.kind === 'paragraph' && block.translatable && ABSTRACT_LEAD.test(plain(block)));
  if (lead) lead.role = 'abstract';
  return blocks;
}

function posixNormalize(value: string): string {
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

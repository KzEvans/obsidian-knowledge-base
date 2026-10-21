import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createCanvasCropper } from '../../src/core/crop-canvas';
import { NORMALIZER_VERSION, cropBox, derive, markAbstract, planCrops, resolveAssetReference, toStoredBlock } from '../../src/core/derive';
import type { CropRequest, CropResult, Cropper } from '../../src/core/derive';
import type { PdfDocument } from '../../src/core/obsidian-internal';
import { segmentHash } from '../../src/core/hash';
import type { ReaderBlock, StoredBlock } from '../../src/core/types';

const SHA = 'c'.repeat(64);
const encoder = new TextEncoder();

function png(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return new Uint8Array(bytes);
}

function raw(files: Record<string, Uint8Array>) {
  const reads: string[] = [];
  return { reads, files: { names: Object.keys(files), read: async (name: string) => { reads.push(name); const bytes = files[name]; if (!bytes) throw new Error('missing ' + name); return bytes; } } };
}

/** A pdf.js stand-in whose pages have too little native text to be audited. */
const quietPdf = (numPages: number) => ({ numPages, getPage: async () => ({ getTextContent: async () => ({ items: [] }), getViewport: () => ({ width: 600, height: 800, scale: 1, convertToViewportPoint: (x: number, y: number) => [x, y] }) }) });

function recordingCropper() {
  const calls: Array<{ page: number; requests: CropRequest[] }> = [];
  const cropper: Cropper = {
    cropPage: async (page, requests) => {
      calls.push({ page, requests });
      return new Map(requests.map(request => [request.blockId, { png: png(300, 200), width: 300, height: 200 } satisfies CropResult]));
    },
  };
  return { calls, cropper };
}

const contentList = [
  { type: 'text', text: 'A Study', text_level: 1, page_idx: 0, bbox: [100, 50, 900, 90] },
  { type: 'text', text: 'Abstract', text_level: 1, page_idx: 0, bbox: [100, 100, 300, 120] },
  { type: 'text', text: 'We show that $x$ works.', page_idx: 0, bbox: [100, 130, 900, 200] },
  { type: 'text', text: '1. Introduction', text_level: 1, page_idx: 0, bbox: [100, 210, 400, 230] },
  { type: 'image', img_path: 'images/fig1.jpg', image_caption: ['Figure 1. Setup.'], page_idx: 0, bbox: [100, 300, 900, 600] },
  { type: 'table', table_body: '<table><tr><td>1</td></tr></table>', table_caption: ['Table 1. Values.'], page_idx: 1, bbox: [100, 100, 900, 400] },
  { type: 'equation', text: '$$E=mc^2$$', page_idx: 1, bbox: [100, 500, 900, 560] },
  { type: 'ref_text', text: '[1] Someone. 2020.', page_idx: 1, bbox: [100, 800, 900, 830] },
];

test('derive normalizes, resolves raw images with sizes, crops tables and image-less formulas, and marks the abstract', async () => {
  const { files, reads } = raw({
    'auto/x_content_list.json': encoder.encode(JSON.stringify(contentList)),
    'auto/images/fig1.jpg': png(640, 480),
  });
  const { calls, cropper } = recordingCropper();
  const { document, derived } = await derive({ sha: SHA, raw: files, pdf: quietPdf(2), cropper });

  assert.equal(document.schemaVersion, 2);
  assert.equal(document.normalizerVersion, NORMALIZER_VERSION);
  assert.equal(document.pageCount, 2);
  assert.ok(reads.includes('auto/images/fig1.jpg'));

  const figure = document.blocks.find(block => block.kind === 'figure')!;
  assert.equal(figure.asset, 'auto/images/fig1.jpg');
  assert.deepEqual(document.assets['auto/images/fig1.jpg'], { path: 'raw/auto/images/fig1.jpg', width: 640, height: 480 });

  assert.deepEqual(calls.map(call => [call.page, call.requests.map(request => request.asset)]), [[2, ['source-tables-v1/block-6.png', 'fallback-v2/block-7.png']]]);
  assert.deepEqual(Object.keys(derived).sort(), ['fallback-v2/block-7.png', 'source-tables-v1/block-6.png']);
  assert.deepEqual(document.assets['source-tables-v1/block-6.png'], { path: 'derived/source-tables-v1/block-6.png', width: 300, height: 200 });
  assert.equal(document.blocks.find(block => block.kind === 'table')!.asset, 'source-tables-v1/block-6.png');

  const abstract = document.blocks.filter(block => block.role === 'abstract');
  assert.deepEqual(abstract.map(block => block.text), ['We show that $x$ works.']);
  const references = document.blocks.find(block => block.kind === 'references')!;
  assert.equal(references.translatable, false);
});

test('existing derived crops are reused and nothing is redrawn', async () => {
  const { files } = raw({ 'x_content_list.json': encoder.encode(JSON.stringify(contentList)), 'images/fig1.jpg': png(10, 10) });
  const { calls, cropper } = recordingCropper();
  const { document, derived } = await derive({ sha: SHA, raw: files, pdf: quietPdf(2), cropper, existingDerived: async asset => png(asset.includes('table') ? 800 : 500, 100) });
  assert.equal(calls.length, 0);
  assert.deepEqual(derived, {});
  assert.deepEqual(document.assets['source-tables-v1/block-6.png'], { path: 'derived/source-tables-v1/block-6.png', width: 800, height: 100 });
});

test('a missing provider image becomes a warning plus a source crop', async () => {
  const list = [{ type: 'image', img_path: 'images/gone.jpg', page_idx: 0, bbox: [100, 100, 500, 500] }];
  const { files } = raw({ 'x_content_list.json': encoder.encode(JSON.stringify(list)) });
  const { calls, cropper } = recordingCropper();
  const { document } = await derive({ sha: SHA, raw: files, pdf: quietPdf(1), cropper });
  assert.ok(document.warnings.some(warning => warning.includes('图片资源缺失')));
  assert.equal(calls[0]!.requests[0]!.asset, 'fallback-v2/block-1.png');
});

test('a cropper that returns nothing for a request fails the stage instead of leaving a silent gap', async () => {
  const { files } = raw({ 'x_content_list.json': encoder.encode(JSON.stringify(contentList)), 'images/fig1.jpg': png(10, 10) });
  await assert.rejects(derive({ sha: SHA, raw: files, pdf: quietPdf(2), cropper: { cropPage: async () => new Map() } }), /裁切失败/);
});

test('crop plan masks only same-page caption boxes of figures', () => {
  const figure: ReaderBlock = { id: 'f', kind: 'figure', text: '', sources: [{ page: 1, bbox: [0, 0, 0.5, 0.5] }, { page: 1, bbox: [0.1, 0.4, 0.4, 0.5] }, { page: 2, bbox: [0, 0, 1, 1] }] };
  const table: ReaderBlock = { id: 't', kind: 'table', text: '', asset: 'images/provider.jpg', sources: [{ page: 1, bbox: [0.25, 0.25, 0.75, 0.75] }, { page: 1, bbox: [0, 0.8, 1, 0.9] }] };
  const withImage: ReaderBlock = { id: 'i', kind: 'figure', text: '', asset: 'images/a.jpg', sources: [{ page: 1, bbox: [0, 0, 1, 1] }] };
  const noBox: ReaderBlock = { id: 'n', kind: 'equation', text: '$x$', sources: [{ page: 1 }] };
  const plan = planCrops([figure, table, withImage, noBox]);
  assert.deepEqual(plan.get(1)!.map(request => [request.blockId, request.masks.length]), [['f', 1], ['t', 0]]);
});

test('crop padding matches the old reader: tables 2pt sides, none on top, 4pt below; figures 10pt', () => {
  const table: CropRequest = { blockId: 't', asset: 'a', kind: 'table', bbox: [0.25, 0.25, 0.75, 0.75], masks: [] };
  assert.deepEqual(cropBox(table, 1000, 800).map(value => Number(value.toFixed(6))), [0.248, 0.25, 0.752, 0.755]);
  const figure: CropRequest = { ...table, kind: 'figure', bbox: [0, 0, 1, 1] };
  assert.deepEqual(cropBox(figure, 1000, 800), [0, 0, 1, 1]);
});

test('asset references resolve archive-relative or content-list-relative, never outside', () => {
  const names = ['auto/images/a.jpg', 'images/b.jpg'];
  assert.equal(resolveAssetReference('images/a.jpg', 'auto', names), 'auto/images/a.jpg');
  assert.equal(resolveAssetReference('images/b.jpg', 'auto', names), 'images/b.jpg');
  assert.equal(resolveAssetReference('../images/b.jpg', '.', names), undefined);
  assert.equal(resolveAssetReference('/etc/passwd', '.', names), undefined);
  assert.equal(resolveAssetReference('https://x/y.jpg', '.', names), undefined);
});

test('segments cover text of prose kinds and captions/footnotes of visuals; hidden, empty and math-only strings are skipped', () => {
  const paragraph = toStoredBlock({ id: 'p', kind: 'paragraph', text: '  The   result. ', sources: [] });
  assert.deepEqual(paragraph.segments, [{ field: 'text', index: 0, sourceHash: segmentHash('The result.') }]);
  const figure = toStoredBlock({ id: 'f', kind: 'figure', text: 'OCR label', captions: ['Figure 1. A.', '$x$'], footnotes: ['Scale bar 1 μm.'], sources: [] });
  assert.deepEqual(figure.segments?.map(segment => [segment.field, segment.index]), [['caption', 0], ['footnote', 0]]);
  assert.equal(toStoredBlock({ id: 'm', kind: 'metadata', text: 'Received 2020', hiddenByDefault: true, sources: [] }).translatable, false);
  assert.equal(toStoredBlock({ id: 'e', kind: 'equation', text: '$$x$$', sources: [] }).translatable, false);
  assert.equal(toStoredBlock({ id: 'r', kind: 'references', text: '[1] A. B.', sources: [] }).translatable, false);
});

test('abstract detection: heading form (up to three paragraphs) and ACS "ABSTRACT:" lead form', () => {
  const p = (text: string, kind: ReaderBlock['kind'] = 'paragraph'): StoredBlock => toStoredBlock({ id: text, kind, text, sources: [] });
  const heading = markAbstract([p('A B S T R A C T', 'heading'), p('One.'), p('Two.'), p('Three.'), p('Four.'), p('Intro', 'heading')]);
  assert.deepEqual(heading.filter(block => block.role).map(block => block.text), ['One.', 'Two.', 'Three.']);
  const acs = markAbstract([p('Title', 'heading'), p('ABSTRACT: Polymerization-induced phase separation.'), p('Body.')]);
  assert.deepEqual(acs.filter(block => block.role).map(block => block.text), ['ABSTRACT: Polymerization-induced phase separation.']);
  assert.equal(markAbstract([p('Body only.')]).some(block => block.role), false);
});

// ---- canvas cropper (ported from the old reader's asset tests) ----

interface CanvasMock { width: number; height: number; draws: unknown[][]; masks: number[][] }

function cropHarness(failure?: 'render' | 'encode') {
  const canvases: CanvasMock[] = [];
  const counters = { rendered: [] as number[], cleaned: [] as number[] };
  const createCanvas = () => {
      const canvas = {
        width: 0, height: 0, draws: [] as unknown[][], masks: [] as number[][],
        getContext: () => ({ drawImage: (...args: unknown[]) => { canvas.draws.push(args); }, fillRect: (...args: number[]) => { canvas.masks.push(args); }, fillStyle: '' }),
        toBlob: (callback: (blob: Blob | null) => void) => queueMicrotask(() => callback(failure === 'encode' ? null : new Blob([png(canvas.width, canvas.height) as Uint8Array<ArrayBuffer>]))),
      };
      canvases.push(canvas);
      return canvas as unknown as HTMLCanvasElement;
  };
  const pdf = {
    getPage: async (number: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 1000 * scale, height: 800 * scale, scale, convertToViewportPoint: () => [0, 0] }),
      render: () => { counters.rendered.push(number); return { promise: failure === 'render' ? Promise.reject(new Error('Source page render failed')) : Promise.resolve() }; },
      cleanup: () => { counters.cleaned.push(number); },
      getTextContent: async () => ({ items: [] }),
    }),
  } as unknown as Pick<PdfDocument, 'getPage'>;
  return { canvases, counters, cropper: createCanvasCropper(pdf, createCanvas, 2) };
}

test('crops on one page share one raster, figure captions are masked, sizes come from the crop', async () => {
  const h = cropHarness();
  const figure: CropRequest = { blockId: 'figure', asset: 'fallback-v2/figure.png', kind: 'figure', bbox: [0, 0, 0.5, 0.5], masks: [[0.1, 0.4, 0.4, 0.5]] };
  const table: CropRequest = { blockId: 'table', asset: 'source-tables-v1/table.png', kind: 'table', bbox: [0.25, 0.25, 0.75, 0.75], masks: [] };
  const results = await h.cropper.cropPage(1, [figure, table]);
  assert.deepEqual(h.counters.rendered, [1]);
  assert.deepEqual(h.counters.cleaned, [1]);
  const crops = h.canvases.filter(canvas => canvas.draws.length);
  assert.equal(crops.length, 2);
  assert.equal(crops[0]!.draws[0]![0], crops[1]!.draws[0]![0]);
  assert.deepEqual(crops[1]!.draws[0]!.slice(1), [496, 400, 1008, 808, 0, 0, 1008, 808]);
  assert.equal(crops[0]!.masks.length, 1);
  assert.equal(crops[1]!.masks.length, 0);
  assert.deepEqual([...results.values()].map(result => [result.width, result.height]), [[1020, 820], [1008, 808]]);
  assert.ok(h.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('render or encode failure releases every canvas and the page', async () => {
  for (const failure of ['render', 'encode'] as const) {
    const h = cropHarness(failure);
    const request: CropRequest = { blockId: 'f', asset: 'fallback-v2/f.png', kind: 'figure', bbox: [0, 0, 0.5, 0.5], masks: [] };
    await assert.rejects(h.cropper.cropPage(1, [request]), failure === 'render' ? /render failed/ : /生成失败/);
    assert.deepEqual(h.counters.cleaned, [1]);
    assert.ok(h.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  }
});

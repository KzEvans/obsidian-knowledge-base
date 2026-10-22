import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Segment } from '../../src/core/types';
import type * as Controller from '../../src/reader/controller';
import type * as Render from '../../src/reader/render';
import type { ReaderRenderOptions, RenderBlock } from '../../src/reader/render';
import { dom, harness, load, rectangle, withGeometry } from './harness';

const renderer = load<typeof Render>('src/reader/render.ts');
const controller = load<typeof Controller>('src/reader/controller.ts');

function segment(sourceHash: string, field: Segment['field'] = 'text', index = 0): Segment {
  return { field, index, sourceHash };
}

function block(id: string, kind: RenderBlock['kind'], text: string, extra: Partial<RenderBlock> = {}): RenderBlock {
  return { id, kind, text, sources: [{ page: 1 }], ...extra };
}

const BLOCKS: RenderBlock[] = [
  block('title', 'heading', 'Dielectric elastomers', { level: 1, segments: [segment('h-title')] }),
  block('body', 'paragraph', 'The field $E=U/d$ drives m<sup>3</sup> strain.', { segments: [segment('h-body')] }),
  block('missing', 'paragraph', 'Not yet translated paragraph.', { segments: [segment('h-missing')] }),
  block('figure', 'figure', 'axis OCR', { asset: 'images/f1.png', captions: ['Fig. 1. Actuator.'], footnotes: ['Measured at $T=20$.'], segments: [segment('h-cap', 'caption'), segment('h-note', 'footnote')] }),
  block('equation', 'equation', '$$S = -p/Y$$'),
  block('list', 'list', '- first item\n- second item', { segments: [segment('h-list')] }),
  block('refs', 'references', '[1] Reference entry.'),
];

const ZH: Record<string, string> = {
  'h-title': '介电弹性体',
  'h-body': '电场 $E=U/d$ 驱动 m<sup>3</sup> 应变。',
  'h-cap': '图 1. 驱动器。',
  'h-note': '在 $T=20$ 下测量。',
  'h-list': '- 第一项\n- 第二项',
};

async function render(options: Partial<ReaderRenderOptions> = {}, blocks = BLOCKS) {
  const { document } = dom();
  const root = document.body.createDiv({ cls: 'pdf-reader-content' });
  await (await renderer).renderReader(root, blocks, {
    fontSize: 18, lineHeight: 1.5, assetUrl: reference => `app://local/${reference}`,
    onSource: () => {}, onCopy: () => {}, onZoom: () => {},
    translation: hash => ZH[hash], ...options,
  });
  return root;
}

function layers(root: HTMLElement, id: string): { en: HTMLElement; zh: HTMLElement } {
  const block = root.querySelector<HTMLElement>(`[data-reader-block-id="${id}"] .pw-block`)!;
  return { en: block.querySelector<HTMLElement>(':scope > .pw-layer[lang="en"]')!, zh: block.querySelector<HTMLElement>(':scope > .pw-layer[lang="zh"]')! };
}

test('each translatable block holds an English and a Chinese layer in one grid block', async () => {
  const root = await render();
  assert.equal(root.dataset.lang, 'en');
  for (const id of ['title', 'body', 'missing', 'list']) {
    const block = root.querySelector<HTMLElement>(`[data-reader-block-id="${id}"] .pw-block`)!;
    const children = Array.from(block.children).map(child => `${child.className}:${child.getAttribute('lang')}`);
    assert.deepEqual(children, ['pw-layer:en', `pw-layer${id === 'missing' ? ' is-untranslated' : ''}:zh`], id);
  }
  const { en, zh } = layers(root, 'body');
  assert.equal(en.getAttribute('aria-hidden'), null);
  assert.equal(zh.getAttribute('aria-hidden'), 'true');
  // Headings keep their element; layers live inside it.
  assert.equal(root.querySelector('[data-reader-block-id="title"] h1 > .pw-block')?.tagName, 'SPAN');
  assert.equal(layers(root, 'title').zh.textContent, '介电弹性体');
  // Lists render their Chinese lines as a list too.
  assert.deepEqual(Array.from(layers(root, 'list').zh.querySelectorAll('li'), item => item.textContent), ['第一项', '第二项']);
});

test('the Chinese layer keeps inline formulas and superscripts', async () => {
  const root = await render();
  const { zh } = layers(root, 'body');
  assert.equal(zh.querySelector<HTMLElement>('.test-math')?.dataset.source, 'E=U/d');
  assert.equal(zh.querySelector('sup')?.textContent, '3');
  assert.ok(!zh.textContent?.includes('<sup>'));
});

test('figures, tables and equations render once; captions and figure notes are bilingual', async () => {
  const root = await render();
  const figure = root.querySelector<HTMLElement>('[data-reader-block-id="figure"]')!;
  assert.equal(figure.querySelectorAll('img').length, 1);
  const caption = figure.querySelector('figcaption .pw-block')!;
  assert.deepEqual(Array.from(caption.children, child => child.textContent), ['Fig. 1. Actuator.', '图 1. 驱动器。']);
  const note = figure.querySelector('.pdf-reader-figure-footnotes .pw-block')!;
  assert.equal(note.querySelector<HTMLElement>('[lang="zh"] .test-math')?.dataset.source, 'T=20');
  const equation = root.querySelector<HTMLElement>('[data-reader-block-id="equation"]')!;
  assert.equal(equation.querySelectorAll('.test-math').length, 1);
  assert.equal(equation.querySelector('.pw-block'), null);
  assert.equal(harness().calls.filter(call => call === 'math:S = -p/Y').length, 1);
  // References are never translated and are not layered.
  assert.equal(root.querySelector('[data-reader-block-id="refs"] .pw-block'), null);
});

test('a segment without a translation shows the English source in the Chinese layer with a light marker', async () => {
  const root = await render();
  const { zh } = layers(root, 'missing');
  assert.ok(zh.classList.contains('is-untranslated'));
  assert.equal(zh.getAttribute('title'), '暂无译文');
  assert.equal(zh.textContent, 'Not yet translated paragraph.');
});

/** Everything except the attributes language switching is allowed to touch. */
function layoutSnapshot(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.removeAttribute('data-lang');
  clone.querySelectorAll('[aria-hidden]').forEach(element => element.removeAttribute('aria-hidden'));
  return clone.outerHTML;
}

test('switching language changes only data-lang and aria-hidden, never structure, classes or styles', async () => {
  const { setLanguage, setZhScale } = await renderer;
  const root = await render();
  setZhScale(root, 0.9);
  const before = layoutSnapshot(root);
  const style = root.getAttribute('style');
  setLanguage(root, 'zh');
  assert.equal(root.dataset.lang, 'zh');
  assert.equal(layoutSnapshot(root), before);
  assert.equal(root.getAttribute('style'), style);
  const { en, zh } = layers(root, 'body');
  assert.equal(en.getAttribute('aria-hidden'), 'true');
  assert.equal(zh.getAttribute('aria-hidden'), null);
  setLanguage(root, 'en');
  assert.equal(layoutSnapshot(root), before);
  assert.equal(layers(root, 'body').zh.getAttribute('aria-hidden'), 'true');
});

test('stylesheet stacks both layers in one cell and hides the inactive one by data-lang only', () => {
  const css = readFileSync(new URL('../../src/reader/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string) => {
    const match = new RegExp(`(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*{([^}]*)}`).exec(css);
    assert.ok(match, `missing rule ${selector}`);
    return match[1]!;
  };
  assert.match(rule('.pw-block'), /display:\s*grid/);
  assert.match(rule('.pw-layer'), /grid-area:\s*1\s*\/\s*1/);
  const hidden = /\.pdf-reader-content\[data-lang="en"\] \.pw-layer\[lang="zh"\],\s*\.pdf-reader-content\[data-lang="zh"\] \.pw-layer\[lang="en"\]:not\(:only-child\)\s*{([^}]*)}/.exec(css);
  assert.ok(hidden);
  assert.match(hidden[1]!, /visibility:\s*hidden/);
  assert.match(hidden[1]!, /user-select:\s*none/);
  assert.doesNotMatch(hidden[1]!, /display|height|font-size|position/);
  // Nothing else keys off the language.
  assert.equal(css.match(/data-lang/g)?.length, 2);
  assert.equal(css.match(/aria-hidden/g), null);
});

test('search covers only the visible language and never markers or tool buttons', async () => {
  const { blockSearchText, setLanguage } = await renderer;
  const root = await render();
  const body = root.querySelector<HTMLElement>('[data-reader-block-id="body"]')!;
  const refs = root.querySelector<HTMLElement>('[data-reader-block-id="refs"]')!;
  assert.ok(blockSearchText(body).includes('drives'));
  assert.ok(!blockSearchText(body).includes('驱动'));
  assert.ok(!blockSearchText(body).includes('原文') && !blockSearchText(body).includes('PDF p.'));
  setLanguage(root, 'zh');
  assert.ok(blockSearchText(body).includes('驱动'));
  assert.ok(!blockSearchText(body).includes('drives'));
  assert.ok(blockSearchText(refs).includes('Reference entry'));
});

test('copy keeps only the visible layer and drops page markers and buttons', async () => {
  const { setLanguage } = await renderer;
  const root = await render();
  setLanguage(root, 'zh');
  const document = root.ownerDocument;
  const article = root.querySelector('article')!;
  const range = { commonAncestorContainer: article, cloneContents: () => { const fragment = createFragment(); fragment.append(article.cloneNode(true)); return fragment; } };
  Object.defineProperty(document, 'getSelection', { value: () => ({ isCollapsed: false, rangeCount: 1, getRangeAt: () => range }), configurable: true });
  let copied: string | undefined;
  let prevented = false;
  const event = { clipboardData: { setData: (type: string, text: string) => { assert.equal(type, 'text/plain'); copied = text; } }, preventDefault: () => { prevented = true; } } as unknown as ClipboardEvent;
  (await controller).copyVisibleText(root, event);
  assert.ok(prevented);
  assert.ok(copied?.includes('电场'));
  assert.ok(copied?.includes('第一项'));
  assert.ok(copied?.includes('Reference entry'));
  assert.ok(!copied?.includes('drives'));
  assert.ok(!copied?.includes('复制页链'));
  assert.ok(!copied?.includes('PDF p.'));
});

test('without translations no Chinese layer exists; arriving translations add and refresh only what changed', async () => {
  const { updateTranslations, setLanguage } = await renderer;
  const root = await render({ translation: undefined });
  assert.equal(root.querySelectorAll('.pw-layer[lang="zh"]').length, 0);
  assert.equal(root.querySelectorAll('.pw-block').length, 6);
  // With only one layer, the zh selector cannot hide the English text.
  setLanguage(root, 'zh');
  assert.equal(root.querySelectorAll('[aria-hidden="true"]').length, 0);
  setLanguage(root, 'en');

  const entries: Record<string, string> = { 'h-body': '电场驱动应变。' };
  assert.equal(await updateTranslations(root, BLOCKS, hash => entries[hash]), 6);
  assert.equal(layers(root, 'body').zh.textContent, '电场驱动应变。');
  assert.ok(layers(root, 'title').zh.classList.contains('is-untranslated'));
  assert.equal(layers(root, 'body').zh.getAttribute('aria-hidden'), 'true');
  assert.equal(await updateTranslations(root, BLOCKS, hash => entries[hash]), 0);
  entries['h-title'] = '介电弹性体';
  assert.equal(await updateTranslations(root, BLOCKS, hash => entries[hash]), 1);
  assert.equal(layers(root, 'title').zh.textContent, '介电弹性体');
  assert.equal(root.querySelectorAll('[data-reader-block-id="title"] .pw-layer[lang="zh"]').length, 1);
});

test('the Chinese font scale minimises the summed height difference and is measured off-flow', async () => {
  const { chooseZhScale, measureZhScale, ZH_SCALES } = await renderer;
  assert.equal(chooseZhScale([0.8, 0.9, 1], scale => [[100, 120 * scale], [50, 55 * scale]]), 0.9);
  assert.equal(chooseZhScale([0.8, 0.9, 1], () => []), undefined);
  assert.ok(ZH_SCALES.includes(1) && ZH_SCALES[0] === 0.8);

  const root = await render();
  let measured = 0;
  const geometry = (element: Element) => {
    const measure = element.closest<HTMLElement>('.pw-measure');
    if (!measure) return rectangle(0, 999);
    measured++;
    const scale = Number(measure.style.getPropertyValue('--pw-zh-scale'));
    return rectangle(0, element.getAttribute('lang') === 'zh' ? 120 * scale : 100);
  };
  withGeometry(root, geometry, () => assert.equal(measureZhScale(root), 0.825));
  // One translated paragraph sampled (the untranslated one is skipped), 13 candidates, two layers each.
  assert.equal(measured, ZH_SCALES.length * 2);
  assert.equal(root.querySelector('.pw-measure'), null);
});

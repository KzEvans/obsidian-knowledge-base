import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { App, TFile } from 'obsidian';
import type { Segment } from '../../src/core/types';
import type * as Layer from '../../src/reader/annotations/layer';
import type * as Render from '../../src/reader/render';
import type { RenderBlock } from '../../src/reader/render';
import { dom, harness, load } from './harness';

const renderer = load<typeof Render>('src/reader/render.ts');
const layers = load<typeof Layer>('src/reader/annotations/layer.ts');

/** Plain objects standing in for Obsidian's files; the layer only reads `path` and `extension`. */
const fake = <T,>(value: object): T => value as T;
const hash = (letter: string) => letter.repeat(64);
const segment = (letter: string, field: Segment['field'] = 'text'): Segment => ({ field, index: 0, sourceHash: hash(letter) });
const BLOCKS: RenderBlock[] = [
  { id: 'b1', kind: 'paragraph', text: 'First paragraph of the paper, long enough to quote.', sources: [{ page: 1 }], segments: [segment('a')] },
  { id: 'b2', kind: 'paragraph', text: 'Second paragraph with its own claim and evidence.', sources: [{ page: 2 }], segments: [segment('b')] },
  { id: 'b3', kind: 'equation', text: '$$x$$', sources: [{ page: 2 }] },
];
const NOTE = '# Title\n\n## 我的理解\n\n## 段落批注\n\n> [!quote] [[p.pdf#page=2|p.2]] %%pw:bbbbbbbbbbbb%%\n> Second paragraph with its own claim and evidence.\n\nmine on two\n\n> [!quote] x %%pw:dddddddddddd%%\n> A paragraph that no longer exists in the paper.\n\nstale\n';

async function setup(note: string | undefined) {
  const { document } = dom();
  const root = document.body.createDiv();
  let annotate: (block: HTMLElement) => void = () => {};
  await (await renderer).renderReader(root, BLOCKS, { fontSize: 18, lineHeight: 1.5, assetUrl: () => '', onSource: () => {}, onCopy: () => {}, onZoom: () => {}, onAnnotate: block => annotate(block) });
  const file = fake<TFile>({ path: 'wiki/papers/Paper.md', extension: 'md' });
  const pdf = fake<TFile>({ path: 'p.pdf' });
  const state = { text: note ?? '' };
  const app = {
    vault: {
      getMarkdownFiles: () => note === undefined ? [] : [file],
      getAbstractFileByPath: (path: string) => path === file.path && note !== undefined ? file : null,
      cachedRead: () => Promise.resolve(state.text),
      process: (_: TFile, change: (data: string) => string) => { state.text = change(state.text); return Promise.resolve(state.text); },
    },
    metadataCache: { getFileCache: () => ({ frontmatter: { type: 'paper', source_sha256: 'sha' } }) },
    fileManager: { generateMarkdownLink: (_: TFile, __: string, subpath: string, alias: string) => `[[p.pdf${subpath}|${alias}]]` },
    workspace: { openLinkText: () => Promise.resolve() },
    scope: {},
    keymap: { pushScope: () => {}, popScope: () => {} },
  } as unknown as App;
  const { AnnotationLayer, segmentTexts } = await layers;
  const layer = new AnnotationLayer({ app, root, pdf, sha: 'sha', segments: segmentTexts(BLOCKS), log: { info() {}, warn() {}, error() {}, debug() {} } as never });
  annotate = block => layer.edit(block);
  await layer.load();
  const block = (id: string) => root.querySelector<HTMLElement>(`[data-reader-block-id="${id}"]`)!;
  const button = (id: string) => Array.from(block(id).querySelectorAll('button')).find(item => item.textContent === '批注');
  return { root, state, block, button };
}

test('blocks with a translation unit get a 批注 tool; cards and orphans come from the note', async () => {
  const { root, block, button } = await setup(NOTE);
  assert.ok(button('b1') && button('b2'));
  assert.equal(button('b3'), undefined, 'a formula has no paragraph text to anchor to');
  assert.equal(block('b1').querySelector('.pw-annotation'), null);
  assert.equal(block('b2').querySelector('.pw-annotation-body')?.textContent, 'mine on two');
  assert.ok(block('b2').classList.contains('has-annotation'));
  const orphans = root.querySelector('.pw-annotation-orphans')!;
  assert.match(orphans.textContent ?? '', /未定位的批注 1 条/);
  assert.match(orphans.textContent ?? '', /stale/);
});

test('writing a new annotation saves it to the note in paper order', async () => {
  const { state, block, button } = await setup(NOTE);
  button('b1')!.click();
  const editor = block('b1').querySelector<HTMLTextAreaElement>('textarea')!;
  editor.value = '  my take on one  ';
  Array.from(block('b1').querySelectorAll('button')).find(item => item.textContent === '保存')!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  const first = state.text.indexOf('%%pw:aaaaaaaaaaaa%%');
  assert.ok(first > 0 && first < state.text.indexOf('%%pw:bbbbbbbbbbbb%%'));
  assert.ok(state.text.includes('> [!quote] [[p.pdf#page=1|p.1]] %%pw:aaaaaaaaaaaa%%\n> First paragraph of the paper, long enough to quote.\n\nmy take on one\n'));
  assert.equal(block('b1').querySelector('textarea'), null);
  assert.equal(block('b1').querySelector('.pw-annotation-body')?.textContent, 'my take on one');
});

test('cancelling a new annotation leaves no card; without a note the tool explains why', async () => {
  const withNote = await setup(NOTE);
  withNote.button('b1')!.click();
  Array.from(withNote.block('b1').querySelectorAll('button')).find(item => item.textContent === '取消')!.click();
  assert.equal(withNote.block('b1').querySelector('.pw-annotation'), null);
  assert.ok(!withNote.block('b1').classList.contains('has-annotation'));

  const without = await setup(undefined);
  without.button('b1')!.click();
  assert.equal(without.block('b1').querySelector('textarea'), null);
  assert.deepEqual(harness().notices, ['这篇论文还没有笔记。请先生成笔记，再写批注。']);
});

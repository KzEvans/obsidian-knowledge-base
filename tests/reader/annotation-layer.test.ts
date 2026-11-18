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

/** `held` collects writes instead of applying them, like a slow disk; calling one applies it, or fails it with `true`. */
async function setup(note: string | undefined, held?: Array<(fail?: boolean) => void>) {
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
      process: (_: TFile, change: (data: string) => string) => {
        if (!held) { state.text = change(state.text); return Promise.resolve(state.text); }
        return new Promise<string>((resolve, reject) => held.push(fail => {
          if (fail) { reject(new Error('disk full')); return; }
          state.text = change(state.text); resolve(state.text);
        }));
      },
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
  return { root, state, block, button, layer, file };
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

const control = (scope: HTMLElement, text: string) => Array.from(scope.querySelectorAll('button')).find(item => item.textContent === text)!;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const TWO = '> [!quote] [[p.pdf#page=2|p.2]] %%pw:bbbbbbbbbbbb%%\n> Second paragraph with its own claim and evidence.\n\n';

/** Open b2's card, type a draft, then let `change` edit the note as Obsidian would. */
async function draftWhile(change: (note: string) => string) {
  const view = await setup(NOTE);
  view.block('b2').querySelector<HTMLElement>('.pw-annotation-body')!.click();
  const editor = view.block('b2').querySelector<HTMLTextAreaElement>('textarea')!;
  editor.value = 'my draft';
  view.state.text = change(view.state.text);
  view.layer.noteChanged(view.file);
  await settle();
  return { ...view, editor };
}

test('a damaged pw: marker is shown as its own unplaced annotation, and saving its neighbour keeps it', async () => {
  const damaged = NOTE.replace('%%pw:bbbbbbbbbbbb%%', '%%pw:typo-bbbbbbbbbbbb%%');
  const { root, state, block, button } = await setup(damaged);
  assert.equal(block('b2').querySelector('.pw-annotation'), null, 'a damaged marker is not placed by its quote either');
  assert.match(root.querySelector('.pw-annotation-orphans')?.textContent ?? '', /未定位的批注 2 条[^]*mine on two[^]*stale/);
  button('b1')!.click();
  block('b1').querySelector<HTMLTextAreaElement>('textarea')!.value = 'one';
  control(block('b1'), '保存').click();
  await settle();
  assert.ok(state.text.includes('%%pw:typo-bbbbbbbbbbbb%%\n> Second paragraph with its own claim and evidence.\n\nmine on two\n'));
});

test('an entry edited in the note while its card is open is not overwritten; the draft stays and a second save is deliberate', async () => {
  const { state, block, editor } = await draftWhile(note => note.replace('mine on two', 'changed in Obsidian'));
  control(block('b2'), '保存').click();
  await settle();
  assert.ok(state.text.includes(`${TWO}changed in Obsidian\n`), 'the note keeps the newer text');
  assert.ok(!state.text.includes('my draft'));
  assert.equal(block('b2').querySelector('textarea'), editor, 'the editor stays open');
  assert.equal(editor.value, 'my draft');
  assert.match(String(harness().notices.at(-1)), /没有覆盖/);
  // Leaving the editor does not decide the conflict…
  block('b2').querySelector('.pw-annotation')!.dispatchEvent(new editor.ownerDocument.defaultView!.Event('focusout'));
  await settle();
  assert.ok(state.text.includes('changed in Obsidian') && block('b2').querySelector('textarea'));
  // …an explicit save does.
  control(block('b2'), '保存').click();
  await settle();
  assert.ok(state.text.includes(`${TWO}my draft\n`) && !state.text.includes('changed in Obsidian'));
  assert.equal(block('b2').querySelector('textarea'), null);
});

test('cancelling after a conflict shows the note\'s version; an entry deleted in the note is not brought back', async () => {
  const edited = await draftWhile(note => note.replace('mine on two', 'changed in Obsidian'));
  control(edited.block('b2'), '保存').click();
  await settle();
  control(edited.block('b2'), '取消').click();
  assert.equal(edited.block('b2').querySelector('.pw-annotation-body')?.textContent, 'changed in Obsidian');

  const deleted = await draftWhile(note => note.replace(`${TWO}mine on two\n\n`, ''));
  control(deleted.block('b2'), '保存').click();
  await settle();
  assert.ok(!deleted.state.text.includes('bbbbbbbbbbbb'), 'the deletion stands');
  assert.equal(deleted.editor.value, 'my draft');
  control(deleted.block('b2'), '取消').click();
  assert.equal(deleted.block('b2').querySelector('.pw-annotation'), null);
});

test('edits elsewhere in the note, or to another annotation, do not block a save', async () => {
  const { state, block } = await draftWhile(note => note.replace('stale', 'stale, edited').replace('# Title\n', '# Title\n\nnew line\n'));
  control(block('b2'), '保存').click();
  await settle();
  assert.ok(state.text.includes(`${TWO}my draft\n`));
  assert.ok(state.text.includes('stale, edited') && state.text.includes('new line'));
});

test('leaving the reader during a conflict keeps the note and hands back the draft', async () => {
  const { state, layer } = await draftWhile(note => note.replace('mine on two', 'changed in Obsidian'));
  layer.dispose();
  await settle();
  assert.ok(state.text.includes('changed in Obsidian') && !state.text.includes('my draft'));
  const notice = harness().notices.at(-1) as unknown as DocumentFragment;
  assert.match(Array.from(notice.childNodes, node => node.textContent).join(""), /my draft/);
  assert.ok(Array.from(notice.querySelectorAll('button')).some(item => item.textContent === '复制草稿'));
});

test('typing on while a save is still writing keeps the newer text in the editor, and the next save writes it', async () => {
  const held: Array<(fail?: boolean) => void> = [];
  const { state, block } = await setup(NOTE, held);
  block('b2').querySelector<HTMLElement>('.pw-annotation-body')!.click();
  const editor = block('b2').querySelector<HTMLTextAreaElement>('textarea')!;
  editor.value = 'v1';
  control(block('b2'), '保存').click();
  editor.value = 'v1 and then v2';
  held.shift()!();
  await settle();
  assert.ok(state.text.includes(`${TWO}v1\n`));
  assert.equal(block('b2').querySelector('textarea'), editor, 'the editor stays open with what was typed since');
  assert.equal(editor.value, 'v1 and then v2');
  control(block('b2'), '保存').click();
  held.shift()!();
  await settle();
  assert.ok(state.text.includes(`${TWO}v1 and then v2\n`), 'the base is the saved v1, so this is no conflict');
  assert.equal(block('b2').querySelector('textarea'), null);
  assert.equal(block('b2').querySelector('.pw-annotation-body')?.textContent, 'v1 and then v2');
});

test('leaving the reader while a save is writing still saves the latest text', async () => {
  const held: Array<(fail?: boolean) => void> = [];
  const { state, block, layer } = await setup(NOTE, held);
  block('b2').querySelector<HTMLElement>('.pw-annotation-body')!.click();
  const editor = block('b2').querySelector<HTMLTextAreaElement>('textarea')!;
  editor.value = 'v1';
  control(block('b2'), '保存').click();
  editor.value = 'v2';
  layer.dispose();
  held.shift()!();
  await settle();
  held.shift()?.();
  await settle();
  assert.ok(state.text.includes(`${TWO}v2\n`), state.text);
});

/** Open b2, save v1 with the write held back, then set the editor to `latest`. */
async function savingWhile(latest: string) {
  const held: Array<(fail?: boolean) => void> = [];
  const view = await setup(NOTE, held);
  view.block('b2').querySelector<HTMLElement>('.pw-annotation-body')!.click();
  const editor = view.block('b2').querySelector<HTMLTextAreaElement>('textarea')!;
  editor.value = 'v1';
  control(view.block('b2'), '保存').click();
  editor.value = latest;
  return { ...view, held, editor };
}

test('undoing back to the saved text and then leaving the reader writes that text after the held write', async () => {
  for (const latest of ['mine on two', '']) {
    const { state, held, layer } = await savingWhile(latest);
    layer.dispose();
    held.shift()!();
    await settle();
    held.shift()?.();
    await settle();
    assert.ok(!state.text.includes('v1'), `${JSON.stringify(latest)}: ${state.text}`);
    assert.equal(state.text.includes(`${TWO}mine on two\n`), latest === 'mine on two');
  }
});

test('a failed write hands back the latest draft when the reader is gone, and keeps the editor for a retry when it is not', async () => {
  const gone = await savingWhile('v2');
  gone.layer.dispose();
  gone.held.shift()!(true);
  await settle();
  assert.ok(!gone.state.text.includes('v1') && !gone.state.text.includes('v2'));
  const notice = harness().notices.at(-1) as unknown as DocumentFragment;
  assert.match(Array.from(notice.childNodes ?? [], node => node.textContent).join(''), /v2/);

  const open = await savingWhile('v2');
  open.held.shift()!(true);
  await settle();
  assert.equal(open.editor.value, 'v2');
  assert.ok(open.editor.isConnected, 'the editor stays for a retry');
  control(open.block('b2'), '保存').click();
  open.held.shift()!();
  await settle();
  assert.ok(open.state.text.includes(`${TWO}v2\n`));
});

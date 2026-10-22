import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { App, Plugin, WorkspaceLeaf } from 'obsidian';
import { EventBus } from '../../src/core/events';
import type { EventMap } from '../../src/core/events';
import type { ModuleContext } from '../../src/core/module';
import type { PdfToolbarButton, PipelineControl } from '../../src/core/services';
import type { Manifest, StoredDocument, TranslationFile } from '../../src/core/types';
import type * as Controller from '../../src/reader/controller';
import type * as Settings from '../../src/reader/settings';
import type { ReaderSettings } from '../../src/reader/settings';
import { dom, harness, load } from './harness';

const controllerModule = load<typeof Controller>('src/reader/controller.ts');
const settingsModule = load<typeof Settings>('src/reader/settings.ts');

const SHA = 'c'.repeat(64);

function storedDocument(): StoredDocument {
  return {
    schemaVersion: 2, sha256: SHA, normalizerVersion: 1, pageCount: 3, warnings: ['第 2 页图片资源缺失，请核对原页。'],
    assets: { 'images/f.png': { path: 'raw/images/f.png', width: 400, height: 200 } },
    blocks: [
      { id: 'p1', kind: 'paragraph', text: 'First page text.', sources: [{ page: 1 }], translatable: true, segments: [{ field: 'text', index: 0, sourceHash: 'h1' }] },
      { id: 'f1', kind: 'figure', text: '', asset: 'images/f.png', captions: ['Fig. 1.'], sources: [{ page: 2 }], translatable: true, segments: [{ field: 'caption', index: 0, sourceHash: 'h2' }] },
      { id: 'p3', kind: 'paragraph', text: 'Third page text.', sources: [{ page: 3 }], translatable: true, segments: [{ field: 'text', index: 0, sourceHash: 'h3' }] },
    ],
  };
}

function translationFile(): TranslationFile {
  return { schemaVersion: 1, entries: { h1: { text: '第一页文字。', model: 'm', termsKey: 'k', at: 'now' } }, failures: {} };
}

interface Setup {
  document?: StoredDocument;
  translations?: TranslationFile;
  manifest?: Manifest;
  pipeline?: boolean;
  settings?: unknown;
}

async function setup(options: Setup = {}) {
  const { document } = dom();
  const { readSettings } = await settingsModule;
  const { ReaderController } = await controllerModule;
  const events = new EventBus();
  const emitted: Array<EventMap['reader:mode-change']> = [];
  events.on('reader:mode-change', payload => emitted.push(payload));

  const containerEl = document.body.createDiv({ cls: 'workspace-leaf-content' });
  containerEl.createDiv({ cls: 'view-actions' });
  const content = containerEl.createDiv({ cls: 'view-content' });
  const native = content.createDiv({ cls: 'pdf-container' });
  const file = { path: 'sources/a.pdf', basename: 'a', stat: { mtime: 1, size: 10 } };
  const ephemeral: unknown[] = [];
  const view = { getViewType: () => 'pdf', containerEl, file, setEphemeralState: (state: unknown) => { ephemeral.push(state); } };
  const leaf = { view } as unknown as WorkspaceLeaf;

  const store = {
    document: options.document,
    translations: options.translations,
    manifest: options.manifest,
    reads: 0,
    indexSha: SHA,
    pdfBytes: new TextEncoder().encode('%PDF-new content'),
    lastSha: '',
  };
  const vaultEvents = new Map<string, (file: typeof view.file) => void>();
  const requested: string[] = [];
  const calls: string[] = [];
  const pipeline: PipelineControl = {
    status: async () => store.manifest,
    requestParse: async path => { requested.push(path); },
    prioritize: sha => calls.push(`prioritize:${sha.slice(0, 4)}`),
    retry: sha => calls.push(`retry:${sha.slice(0, 4)}`),
    cancel: () => {},
  };
  let button: PdfToolbarButton | undefined;
  const commands = new Map<string, { checkCallback: (checking: boolean) => boolean | void }>();
  const settings = readSettings(options.settings);
  let saves = 0;
  const context = {
    app: {
      workspace: {
        on: () => ({}), onLayoutReady: (callback: () => void) => callback(),
        iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void) => callback(leaf),
        getMostRecentLeaf: () => leaf,
      },
      vault: { on: (name: string, callback: (file: typeof view.file) => void) => { vaultEvents.set(name, callback); return {}; }, adapter: { readBinary: async () => store.pdfBytes.slice().buffer } },
      fileManager: { generateMarkdownLink: (_file: unknown, _source: string, subpath: string, alias: string) => `[[a.pdf${subpath}|${alias}]]` },
    } as unknown as App,
    plugin: {
      registerEvent: () => {}, addCommand: (command: { id: string; checkCallback: (checking: boolean) => boolean | void }) => { commands.set(command.id, command); },
      manifest: { version: 'test' },
    } as unknown as Plugin,
    events,
    services: {
      ...(options.pipeline === false ? {} : { pipeline }),
      pdfToolbar: { register: (registered: PdfToolbarButton) => { button = registered; return () => {}; }, refresh: () => {} },
    },
    store: {
      shaForPath: async () => store.indexSha,
      manifest: async () => store.manifest,
      document: async (sha: string) => { store.reads++; store.lastSha = sha; return store.document && structuredClone(store.document); },
      translations: async () => store.translations,
      conflicts: async () => [],
      assetUrl: (sha: string, assetPath: string) => `app://local/.research/papers/${sha.slice(0, 4)}/${assetPath}`,
    },
    settings,
    saveSettings: async () => { saves++; },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pluginDir: '/nonexistent',
  } as unknown as ModuleContext<ReaderSettings>;
  const controller = new ReaderController(context);
  controller.start();
  const click = async () => { button!.onClick(leaf, document.body.createEl('button')); await settle(); };
  const command = async (id: string) => { const ran = commands.get(id)!.checkCallback(false); await settle(); return ran; };
  const root = () => content.querySelector<HTMLElement>('.pdf-reader-content');
  const panel = () => content.querySelector<HTMLElement>('.pdf-reader-processing');
  return { leaf, view, controller, events, emitted, button: () => button!, click, command, commands, root, panel, native, content, store, requested, calls, settings, ephemeral, file, modify: () => vaultEvents.get('modify')?.(file), saves: () => saves };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, 1));
}

test('the toolbar button is registered at order 10 and opens the reader with the documented root contract', async () => {
  const env = await setup({ document: storedDocument(), translations: translationFile(), manifest: undefined });
  assert.equal(env.button().order, 10);
  assert.equal(env.button().id, 'reader-mode');
  await env.click();
  const root = env.root()!;
  assert.ok(root);
  assert.equal(root.dataset.pdfReaderActive, 'true');
  assert.equal(root.dataset.lang, 'en');
  assert.ok(env.native.classList.contains('pw-reader-native-hidden'));
  assert.equal(env.native.getAttribute('aria-hidden'), 'true');
  assert.deepEqual(env.emitted, [{ leafId: env.emitted[0]!.leafId, active: true, language: 'en' }]);
  assert.match(env.emitted[0]!.leafId, /^leaf-\d+$/);
  // Images come from the store by the asset's stored path, with reserved size.
  const image = root.querySelector('img')!;
  assert.equal(image.getAttribute('src'), 'app://local/.research/papers/cccc/raw/images/f.png');
  assert.equal(image.getAttribute('width'), '400');
  assert.ok(root.parentElement!.querySelector('.pdf-reader-warnings')?.textContent?.includes('1'));
  // Reader chrome is marked as UI for selection (contracts §6.1).
  assert.ok(env.content.querySelector('.pdf-reader-toolbar')?.hasAttribute('data-pw-ui'));
});

test('switching language emits mode-change and only flips data-lang; leaving emits inactive', async () => {
  const env = await setup({ document: storedDocument(), translations: translationFile() });
  await env.click();
  const toggle = env.content.querySelector<HTMLButtonElement>('.pw-reader-language')!;
  assert.equal(toggle.disabled, false);
  assert.equal(await env.command('reader-toggle-language'), true);
  assert.equal(env.root()!.dataset.lang, 'zh');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(env.emitted.map(event => [event.active, event.language]), [[true, 'en'], [true, 'zh']]);
  await env.click();
  assert.equal(env.root(), null);
  assert.deepEqual(env.emitted.at(-1), { leafId: env.emitted[0]!.leafId, active: false, language: 'zh' });
  assert.ok(!env.native.classList.contains('pw-reader-native-hidden'));
});

test('before any translation the language toggle is disabled and the command unavailable', async () => {
  const env = await setup({ document: storedDocument(), manifest: { schemaVersion: 1, sha256: SHA, sources: [], stage: 'normalizing', failure: null, priority: false, updatedAt: 'now' } });
  await env.click();
  const toggle = env.content.querySelector<HTMLButtonElement>('.pw-reader-language')!;
  assert.equal(toggle.disabled, true);
  assert.equal(env.commands.get('reader-toggle-language')!.checkCallback(true), false);
  assert.equal(env.root()!.querySelectorAll('.pw-layer[lang="zh"]').length, 0);
  assert.equal(env.content.querySelector('.pdf-reader-status')?.textContent, '整理中');
});

test('while parsing, the reader shows stage and progress, offers priority, and opens when the document lands', async () => {
  const manifest: Manifest = { schemaVersion: 1, sha256: SHA, sources: [], stage: 'parsing', failure: null, priority: false, updatedAt: 'now' };
  const env = await setup({ manifest });
  await env.click();
  assert.equal(env.root(), null);
  assert.equal(env.panel()?.querySelector('strong')?.textContent, '解析中');
  assert.ok(env.panel()?.hasAttribute('data-pw-ui'));
  env.events.emit('paper:parse-progress', { sha: SHA, done: 5, total: 10 });
  assert.equal(env.panel()?.querySelector('.pw-reader-status-detail')?.textContent, '5/10 页');
  const prioritize = env.panel()!.querySelector<HTMLButtonElement>('[data-action="prioritize"]')!;
  prioritize.dispatchEvent(new prioritize.ownerDocument.defaultView!.Event('click'));
  await settle();
  assert.deepEqual(env.calls, ['prioritize:cccc']);

  env.store.document = storedDocument();
  env.store.manifest = { ...manifest, stage: 'translating' };
  env.events.emit('paper:stage-changed', { sha: SHA, stage: 'translating' });
  await settle();
  assert.equal(env.root()?.dataset.pdfReaderActive, 'true');
  assert.equal(env.panel(), null);
  assert.equal(env.content.querySelectorAll('.pdf-reader-shell').length, 1);
});

test('a failed paper shows the failed stage and error with a retry through the pipeline', async () => {
  const env = await setup({ manifest: { schemaVersion: 1, sha256: SHA, sources: [], stage: 'failed', failure: { stage: 'parsing', error: 'MinerU 解析失败', attempts: 5, at: 'now', retryable: true }, priority: false, updatedAt: 'now' } });
  await env.click();
  assert.equal(env.panel()?.getAttribute('role'), 'alert');
  assert.equal(env.panel()?.querySelector('strong')?.textContent, '解析中阶段失败');
  assert.ok(env.panel()?.textContent?.includes('MinerU 解析失败'));
  const retry = env.panel()!.querySelector<HTMLButtonElement>('[data-action="retry"]')!;
  retry.dispatchEvent(new retry.ownerDocument.defaultView!.Event('click'));
  assert.deepEqual(env.calls, ['retry:cccc']);
});

test('a PDF outside the library is parsed only after you confirm', async () => {
  const env = await setup({});
  await env.click();
  const modals = harness().modals;
  assert.equal(modals.length, 1);
  assert.equal(modals[0]!.kind, 'ConfirmModal');
  assert.deepEqual(env.requested, []);
  const confirm = (modals[0] as unknown as { modal: { contentEl: HTMLElement } }).modal.contentEl.querySelector<HTMLButtonElement>('.mod-cta')!;
  confirm.dispatchEvent(new confirm.ownerDocument.defaultView!.Event('click'));
  await settle();
  assert.deepEqual(env.requested, ['sources/a.pdf']);
});

test('without the library module the reader explains it and asks nothing', async () => {
  const env = await setup({ pipeline: false });
  await env.click();
  assert.equal(harness().modals.length, 0);
  assert.ok(env.panel()?.textContent?.includes('文献库模块未加载'));
  assert.equal(env.panel()?.querySelectorAll('[data-action]').length, 0);
});

test('reading positions are stored by sha256, so a renamed PDF reopens at the same page', async () => {
  const env = await setup({ document: storedDocument(), settings: { positions: { [SHA]: 3 } } });
  await env.click();
  assert.equal(env.content.querySelector<HTMLInputElement>('.pdf-reader-page-input')?.value, '3');
  await env.click();
  // Leaving saves the page under the paper's sha and syncs the native view to it.
  assert.deepEqual(Object.keys(env.settings.positions), [SHA]);
  assert.deepEqual(env.ephemeral.at(-1), { subpath: '#page=3', focus: false });
  env.file.path = 'sources/moved/renamed.pdf';
  env.settings.positions[SHA] = 2;
  await env.click();
  assert.equal(env.content.querySelector<HTMLInputElement>('.pdf-reader-page-input')?.value, '2');
});

test('reopening a paper reuses the in-memory document', async () => {
  const env = await setup({ document: storedDocument() });
  await env.click();
  await env.click();
  await env.click();
  assert.equal(env.store.reads, 1);
  env.events.emit('paper:document-updated', { sha: SHA, normalizerVersion: 2 });
  await settle();
  assert.equal(env.store.reads, 2);
  assert.equal(env.root()?.dataset.pdfReaderActive, 'true');
});

test('a #page link moves the reader; a selection link returns to the native view', async () => {
  const env = await setup({ document: storedDocument() });
  await env.click();
  env.view.setEphemeralState({ subpath: '#page=3' });
  assert.equal(env.content.querySelector<HTMLInputElement>('.pdf-reader-page-input')?.value, '3');
  assert.ok(env.root());
  env.view.setEphemeralState({ subpath: '#page=2&selection=4,0,4,10' });
  assert.equal(env.root(), null);
  assert.deepEqual(env.ephemeral.at(-1), { subpath: '#page=2&selection=4,0,4,10' });
});

test('disposing closes the reader and restores the view', async () => {
  const env = await setup({ document: storedDocument() });
  await env.click();
  const wrapped = env.view.setEphemeralState;
  env.controller.dispose();
  assert.notEqual(env.view.setEphemeralState, wrapped);
  assert.equal(env.root(), null);
  assert.equal(env.emitted.at(-1)?.active, false);
  assert.ok(!env.native.classList.contains('pw-reader-native-hidden'));
});


async function waitUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('reader condition not reached');
}

test('saved SHA position takes priority over a native PDF default page, while an explicit page link wins', async () => {
  const env = await setup({ document: storedDocument(), settings: { positions: { [SHA]: 3 } } });
  env.native.createEl('input', { cls: 'page-number', type: 'number', value: '1' });
  await env.click();
  assert.equal(env.content.querySelector<HTMLInputElement>('.pdf-reader-page-input')?.value, '3');
  await env.click();
  env.view.setEphemeralState({ subpath: '#page=2' });
  await env.click();
  assert.equal(env.content.querySelector<HTMLInputElement>('.pdf-reader-page-input')?.value, '2');
  env.controller.dispose();
});

test('PDF modification rehashes bytes before the library index catches up and follows the new SHA', async () => {
  const { sha256Bytes } = await import('../../src/core/hash');
  const env = await setup({ document: storedDocument() });
  await env.click();
  env.store.document = storedDocument();
  env.store.document.blocks[0]!.text = 'Changed PDF content';
  const newSha = await sha256Bytes(env.store.pdfBytes);
  env.file.stat.mtime = 2;
  env.modify();
  await waitUntil(() => env.root()?.dataset.pdfReaderActive === 'true');
  assert.equal(env.store.lastSha, newSha);
  assert.ok(env.root()?.textContent?.includes('Changed PDF content'));
  env.store.indexSha = newSha;
  env.events.emit('paper:document-updated', { sha: newSha, normalizerVersion: 2 });
  await settle();
  assert.equal(env.store.lastSha, newSha);
  env.controller.dispose();
});

test('translations arriving during the first render update every block after mounting', async () => {
  const document = storedDocument();
  document.blocks = Array.from({ length: 400 }, (_, index) => ({ id: `p${index}`, kind: 'paragraph', text: `Original ${index}`, sources: [{ page: 1 }], translatable: true, segments: [{ field: 'text', index: 0, sourceHash: `h${index}` }] }));
  const env = await setup({ document, translations: translationFile(), manifest: { schemaVersion: 1, sha256: SHA, sources: [], stage: 'translating', failure: null, priority: false, updatedAt: 'x' } });
  env.button().onClick(env.leaf, env.content.createEl('button'));
  await waitUntil(() => !!env.root()?.querySelector('.pw-block'));
  env.store.translations = { schemaVersion: 1, failures: {}, entries: Object.fromEntries(document.blocks.map((_, index) => [`h${index}`, { text: `New translation ${index}`, model: 'm', termsKey: '', at: '' }])) };
  env.store.manifest = { ...env.store.manifest!, stage: 'ready' };
  env.events.emit('paper:stage-changed', { sha: SHA, stage: 'ready' });
  await waitUntil(() => env.root()?.dataset.pdfReaderActive === 'true');
  await settle();
  const chinese = Array.from(env.root()!.querySelectorAll('.pw-layer[lang="zh"]'));
  assert.equal(chinese.length, document.blocks.length);
  assert.ok(chinese.every(layer => layer.textContent?.startsWith('New translation')));
  env.controller.dispose();
});

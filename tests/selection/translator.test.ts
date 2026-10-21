import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import type { WorkspaceLeaf } from 'obsidian';
import { EventBus } from '../../src/core/events';
import type { ModuleContext } from '../../src/core/module';
import { leafId } from '../../src/core/pdf-toolbar';
import { SELECTION_MODEL } from '../../src/core/qwen-mt';
import type { TranslateRequest } from '../../src/core/qwen-mt';
import type { PdfToolbarButton } from '../../src/core/services';
import { importLegacySettings, readSettings } from '../../src/reader/selection/settings';
import type { SelectionSettings } from '../../src/reader/selection/settings';
import { SelectionTranslator } from '../../src/reader/selection/translator';
import { notices } from '../stubs/obsidian';

// ---- DOM: linkedom plus the few Obsidian element helpers the popup uses ----

interface ElementInfo { cls?: string; text?: string; attr?: Record<string, string> }

const XHTML = 'http://www.w3.org/1999/xhtml';

/** One PDF leaf's container, as Obsidian lays it out; `content` goes into .view-content. */
function createDom(content: string) {
  const { window, document, HTMLElement } = parseHTML(`<!doctype html><html><body><div class="leaf"><div class="view-header"><div class="view-actions"></div></div><div class="view-content">${content}</div></div></body></html>`);
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const append = (parent: HTMLElement, tag: string, info: ElementInfo = {}) => {
    const element = parent.ownerDocument.createElementNS(XHTML, tag);
    if (info.cls) element.setAttribute('class', info.cls);
    if (info.text !== undefined) element.textContent = info.text;
    for (const [name, value] of Object.entries(info.attr ?? {})) element.setAttribute(name, value);
    parent.appendChild(element);
    return element;
  };
  proto.createEl = function (this: HTMLElement, tag: string, info?: ElementInfo) { return append(this, tag, info); };
  proto.createDiv = function (this: HTMLElement, info?: ElementInfo) { return append(this, 'div', info); };
  proto.createSpan = function (this: HTMLElement, info?: ElementInfo) { return append(this, 'span', info); };
  (window as unknown as { requestAnimationFrame: (callback: () => void) => number }).requestAnimationFrame = callback => { callback(); return 0; };
  (document as unknown as { getSelection: () => null }).getSelection = () => null;
  return { window, document };
}

const NATIVE = '<div class="pdf-container"><div class="pdf-viewer-container"><div class="textLayer"><span class="native">Dielectric elastomers deform under voltage.</span></div></div></div>';

const READER = (active: boolean, lang: 'en' | 'zh') => `${NATIVE}
  <div class="pdf-reader-content" data-pdf-reader-active="${active}" data-lang="${lang}">
    <div class="pw-block" data-block-id="b1">
      <div class="pw-layer en1" lang="en"${lang === 'zh' ? ' aria-hidden="true"' : ''}>Soft actuators are compliant.</div>
      <div class="pw-layer zh1" lang="zh"${lang === 'en' ? ' aria-hidden="true"' : ''}>软执行器是柔顺的。</div>
    </div>
    <div class="pw-block" data-block-id="b2">
      <div class="pw-layer en2" lang="en"${lang === 'zh' ? ' aria-hidden="true"' : ''}>They are light.</div>
      <div class="pw-layer zh2" lang="zh"${lang === 'en' ? ' aria-hidden="true"' : ''}>它们很轻。</div>
    </div>
  </div>`;

function makeLeaf(document: Document, file = 'papers/a.pdf') {
  const containerEl = document.querySelector<HTMLElement>('.leaf')!;
  const handle = { file };
  const leaf = { view: { containerEl, getViewType: () => 'pdf', getState: () => ({ file: handle.file }) } } as unknown as WorkspaceLeaf;
  return { leaf, containerEl, handle };
}

/** linkedom has no Selection; this stands in for document.getSelection(). */
function select(document: Document, node: Node, text: string, extra: Partial<Range> = {}) {
  const rect = { left: 100, top: 100, right: 200, bottom: 120, width: 100, height: 20 };
  const range = {
    commonAncestorContainer: node, startContainer: node, endContainer: node,
    cloneRange: () => range,
    cloneContents: () => { const real = document.createRange(); real.selectNode(node); return real.cloneContents(); },
    getClientRects: () => [rect],
    getBoundingClientRect: () => rect,
    ...extra,
  } as unknown as Range;
  const selection = {
    isCollapsed: false, rangeCount: 1, cleared: false,
    getRangeAt: () => range,
    toString: () => text,
    removeAllRanges() { selection.rangeCount = 0; selection.cleared = true; },
  };
  (document as unknown as { getSelection: () => typeof selection }).getSelection = () => selection;
  return selection;
}

interface Pending { request: TranslateRequest; resolve(value: string): void; reject(error: Error): void }

function harness(content: string = NATIVE, options: { key?: string | null; glossary?: { source: string; target: string }[] } = {}) {
  const { window, document } = createDom(content);
  (globalThis as unknown as { activeDocument: Document }).activeDocument = document;
  const leaves: WorkspaceLeaf[] = [];
  const buttons: PdfToolbarButton[] = [];
  const commands: Array<{ id: string; checkCallback?(checking: boolean): boolean | void }> = [];
  const pending: Pending[] = [];
  let auto = true;
  const events = new EventBus();
  const settings = readSettings(undefined);
  const context = {
    app: {
      workspace: { iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void) => leaves.forEach(callback), on: () => ({}), onLayoutReady: (callback: () => void) => callback() },
      vault: { configDir: '.obsidian', adapter: { exists: () => Promise.resolve(false), read: () => Promise.reject(new Error('no file')) } },
    },
    plugin: {
      addCommand: (command: (typeof commands)[number]) => { commands.push(command); },
      register: () => {},
      registerEvent: () => {},
      registerDomEvent: (target: EventTarget, type: string, listener: EventListener, opts?: AddEventListenerOptions) => target.addEventListener(type, listener, opts),
    },
    events,
    services: { pdfToolbar: { register: (button: PdfToolbarButton) => { buttons.push(button); return () => {}; }, refresh: () => {} } },
    settings,
    saveSettings: () => Promise.resolve(),
    core: { qwenMtEndpoint: '', glossary: options.glossary ?? [] },
    secrets: { get: () => options.key === undefined ? 'test-key-not-real-0000' : options.key, set: () => {} },
    qwenMt: {
      translate: (request: TranslateRequest) => new Promise<string>((resolve, reject) => {
        pending.push({ request, resolve, reject });
        if (auto) resolve(`译文：${request.text}`);
      }),
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    vaultPath: '/vault', pluginDir: '/vault/.obsidian/plugins/paper-workbench',
  } as unknown as ModuleContext<SelectionSettings>;

  const translator = new SelectionTranslator(context);
  translator.start();
  const { leaf, containerEl, handle } = makeLeaf(document);
  leaves.push(leaf);
  translator.refresh();

  return {
    window, document, translator, leaf, containerEl, handle, events, settings, buttons, commands, pending,
    manual() { auto = false; },
    enable() { buttons[0]!.onClick(leaf, document.body.createEl('button')); },
    popup: () => document.querySelector('.pw-selection-popup'),
    popupText: () => document.querySelector('.pw-selection-popup-body')?.textContent ?? '',
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// ---- tests ----

test('registers a toolbar button at order 20 and a command; enabling needs a saved API key', () => {
  const noKey = harness(NATIVE, { key: null });
  assert.equal(noKey.buttons.length, 1);
  assert.equal(noKey.buttons[0]!.order, 20);
  assert.equal(noKey.commands[0]!.id, 'toggle-selection-translation');
  noKey.enable();
  assert.equal(noKey.translator.isEnabled(noKey.leaf), false);
  assert.match(notices.at(-1) ?? '', /API Key/);

  const h = harness();
  h.enable();
  assert.equal(h.translator.isEnabled(h.leaf), true);
  const button = h.document.body.createEl('button');
  h.buttons[0]!.update!(h.leaf, button);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.ok(button.classList.contains('is-enabled'));
});

test('a disabled tab never translates', async () => {
  const h = harness();
  select(h.document, h.containerEl.querySelector('.native')!.firstChild!, 'Dielectric elastomers deform under voltage.');
  h.translator.handleSelection(h.document);
  await settle();
  assert.equal(h.pending.length, 0);
  assert.equal(h.popup(), null);
});

test('native PDF view: sends only the selected text with the selection model and glossary', async () => {
  const glossary = [{ source: 'dielectric elastomer', target: '介电弹性体' }];
  const h = harness(NATIVE, { glossary });
  h.enable();
  select(h.document, h.containerEl.querySelector('.native')!.firstChild!, 'Dielectric elas-\ntomers   deform under voltage.');
  h.translator.handleSelection(h.document);
  await settle();

  assert.equal(h.pending.length, 1);
  const request = h.pending[0]!.request;
  assert.deepEqual(Object.keys(request).sort(), ['model', 'signal', 'terms', 'text', 'timeoutMs']);
  assert.equal(request.text, 'Dielectric elastomers deform under voltage.');
  assert.equal(request.model, SELECTION_MODEL);
  assert.equal(request.terms, glossary);
  assert.equal(request.timeoutMs, 30_000);
  assert.ok(!JSON.stringify({ ...request, signal: undefined }).includes('a.pdf'));
  assert.equal(h.popupText(), '译文：Dielectric elastomers deform under voltage.');
  assert.equal(h.popup()!.getAttribute('data-translation'), '译文：Dielectric elastomers deform under voltage.');
});

test('selection end (mouseup) triggers translation after the debounce', async () => {
  const h = harness();
  h.enable();
  select(h.document, h.containerEl.querySelector('.native')!, 'Dielectric elastomers deform under voltage.');
  const mouseup = new h.window.Event('mouseup') as unknown as MouseEvent;
  Object.assign(mouseup, { clientX: 150, clientY: 110 });
  h.document.dispatchEvent(mouseup);
  assert.equal(h.pending.length, 0);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.pending.length, 1);
});

test('reading mode English layer translates; a selection across blocks drops the hidden Chinese', async () => {
  const h = harness(READER(true, 'en'));
  h.enable();
  const reader = h.containerEl.querySelector('.pdf-reader-content')!;
  select(h.document, reader, 'ignored: reader text comes from the DOM');
  h.translator.handleSelection(h.document);
  await settle();
  assert.equal(h.pending.length, 1);
  assert.equal(h.pending[0]!.request.text, 'Soft actuators are compliant.\nThey are light.');
});

test('reading mode Chinese layer never translates', async () => {
  const h = harness(READER(true, 'zh'));
  h.enable();
  select(h.document, h.containerEl.querySelector('.zh1')!.firstChild!, '软执行器是柔顺的。');
  h.translator.handleSelection(h.document);
  await settle();
  assert.equal(h.pending.length, 0);

  // Also when the DOM attribute lags behind the event.
  const lagging = harness(READER(true, 'en'));
  lagging.enable();
  lagging.events.emit('reader:mode-change', { leafId: leafId(lagging.leaf), active: true, language: 'zh' });
  select(lagging.document, lagging.containerEl.querySelector('.en1')!.firstChild!, 'Soft actuators are compliant.');
  lagging.translator.handleSelection(lagging.document);
  await settle();
  assert.equal(lagging.pending.length, 0);
});

test('a selection inside the hidden (aria-hidden) layer is ignored', async () => {
  const h = harness(READER(true, 'en'));
  h.enable();
  select(h.document, h.containerEl.querySelector('.zh1')!.firstChild!, '软执行器是柔顺的。');
  h.translator.handleSelection(h.document);
  await settle();
  assert.equal(h.pending.length, 0);
});

test('with reading mode active, selections in the covered native layer are ignored', async () => {
  const h = harness(READER(true, 'en'));
  h.enable();
  select(h.document, h.containerEl.querySelector('.native')!.firstChild!, 'Dielectric elastomers deform under voltage.');
  h.translator.handleSelection(h.document);
  await settle();
  assert.equal(h.pending.length, 0);
});

test('reader:mode-change clears popup, in-flight request and selection for that tab', async () => {
  const h = harness(READER(true, 'en'));
  h.manual();
  h.enable();
  const selection = select(h.document, h.containerEl.querySelector('.en1')!, 'Soft actuators are compliant.');
  h.translator.handleSelection(h.document);
  assert.ok(h.popup());
  const signal = h.pending[0]!.request.signal!;

  h.events.emit('reader:mode-change', { leafId: 'leaf-unrelated', active: true, language: 'zh' });
  assert.ok(h.popup(), 'other tabs are untouched');

  h.events.emit('reader:mode-change', { leafId: leafId(h.leaf), active: false, language: 'en' });
  assert.equal(h.popup(), null);
  assert.equal(signal.aborted, true);
  assert.equal(selection.cleared, true);
  h.pending[0]!.resolve('late');
  await settle();
  assert.equal(h.popup(), null);
});

test('opening another PDF in the same tab clears the popup and request', () => {
  const h = harness();
  h.manual();
  h.enable();
  select(h.document, h.containerEl.querySelector('.native')!, 'Dielectric elastomers deform under voltage.');
  h.translator.handleSelection(h.document);
  assert.ok(h.popup());
  h.handle.file = 'papers/b.pdf';
  h.translator.refresh();
  assert.equal(h.popup(), null);
  assert.equal(h.pending[0]!.request.signal!.aborted, true);
  assert.equal(h.translator.isEnabled(h.leaf), true, 'the per-tab switch survives a file change');
});

test('selections over the character limit show an error and send nothing', async () => {
  const h = harness();
  h.enable();
  h.settings.maxSelectionCharacters = 1_000;
  select(h.document, h.containerEl.querySelector('.native')!, 'x'.repeat(1_001));
  h.translator.handleSelection(h.document);
  await settle();
  assert.equal(h.pending.length, 0);
  assert.match(h.popupText(), /超过当前上限 1,000/);
  assert.equal(h.document.querySelector('.pw-selection-retry'), null);
});

test('the same text is served from the session cache without a second request', async () => {
  const h = harness();
  h.enable();
  const node = h.containerEl.querySelector('.native')!;
  select(h.document, node, 'Dielectric elastomers deform under voltage.');
  h.translator.handleSelection(h.document);
  await settle();
  h.document.querySelector<HTMLElement>('.pw-selection-close')!.click();
  assert.equal(h.popup(), null);

  select(h.document, node, 'Dielectric elastomers deform under voltage.');
  h.translator.handleSelection(h.document);
  await settle();
  assert.equal(h.pending.length, 1);
  assert.equal(h.popupText(), '译文：Dielectric elastomers deform under voltage.');
});

test('a new selection cancels the previous request and ignores its late result', async () => {
  const h = harness();
  h.manual();
  h.enable();
  const node = h.containerEl.querySelector('.native')!;
  select(h.document, node, 'First sentence.');
  h.translator.handleSelection(h.document);
  select(h.document, node, 'Second sentence.');
  h.translator.handleSelection(h.document);

  assert.equal(h.pending.length, 2);
  assert.equal(h.pending[0]!.request.signal!.aborted, true);
  assert.equal(h.pending[1]!.request.signal!.aborted, false);
  h.pending[0]!.resolve('第一句。');
  await settle();
  assert.match(h.popupText(), /正在翻译/);
  h.pending[1]!.resolve('第二句。');
  await settle();
  assert.equal(h.popupText(), '第二句。');
  assert.equal(h.document.querySelectorAll('.pw-selection-popup').length, 1);
});

test('errors are shown redacted, with a retry button', async () => {
  const h = harness();
  h.manual();
  h.enable();
  select(h.document, h.containerEl.querySelector('.native')!, 'Dielectric elastomers.');
  h.translator.handleSelection(h.document);
  h.pending[0]!.reject(new Error('请求失败 Authorization: Bearer sk-abcdef1234567890 https://x.test/?token=SECRETVALUE'));
  await settle();
  const text = h.popupText();
  assert.match(text, /请求失败/);
  assert.ok(!text.includes('sk-abcdef1234567890'));
  assert.ok(!text.includes('SECRETVALUE'));
  assert.ok(h.document.querySelector('.pw-selection-retry'));
});

test('Escape closes the popup and aborts the request', () => {
  const h = harness();
  h.manual();
  h.enable();
  select(h.document, h.containerEl.querySelector('.native')!, 'Dielectric elastomers.');
  h.translator.handleSelection(h.document);
  const escape = new h.window.Event('keydown') as unknown as KeyboardEvent;
  Object.assign(escape, { key: 'Escape' });
  h.document.dispatchEvent(escape);
  assert.equal(h.popup(), null);
  assert.equal(h.pending[0]!.request.signal!.aborted, true);
});

test('settings: defaults, clamping, and a one-time import from the old plugin', async () => {
  assert.deepEqual(readSettings(undefined), { maxSelectionCharacters: 8_000, timeoutSeconds: 30, legacyImported: false });
  assert.deepEqual(readSettings({ maxSelectionCharacters: 50, timeoutSeconds: 999, legacyImported: true }), { maxSelectionCharacters: 1_000, timeoutSeconds: 120, legacyImported: true });

  const reads: string[] = [];
  const adapter = {
    exists: () => Promise.resolve(true),
    read: (file: string) => { reads.push(file); return Promise.resolve(JSON.stringify({ targetLanguage: 'English', maxSelectionCharacters: 12_000, timeoutSeconds: 45, qwenEndpoint: 'https://x' })); },
  };
  const settings = readSettings(undefined);
  assert.equal(await importLegacySettings(adapter, '.obsidian', settings), true);
  assert.deepEqual(settings, { maxSelectionCharacters: 12_000, timeoutSeconds: 45, legacyImported: true });
  assert.deepEqual(reads, ['.obsidian/plugins/pdf-selection-translator/data.json']);

  settings.timeoutSeconds = 10;
  assert.equal(await importLegacySettings(adapter, '.obsidian', settings), false);
  assert.equal(settings.timeoutSeconds, 10);
  assert.equal(reads.length, 1);
});

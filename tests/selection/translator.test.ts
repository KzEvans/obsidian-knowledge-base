import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import type { WorkspaceLeaf } from 'obsidian';
import { EventBus } from '../../src/core/events';
import type { ModuleContext } from '../../src/core/module';
import { leafId } from '../../src/core/pdf-toolbar';
import { SELECTION_MODEL } from '../../src/core/qwen-mt';
import type { TranslateRequest } from '../../src/core/qwen-mt';
import type { Term } from '../../src/core/types';
import type { PdfToolbarButton } from '../../src/core/services';
import { importLegacySettings, readSettings } from '../../src/reader/selection/settings';
import type { SelectionSettings } from '../../src/reader/selection/settings';
import { SelectionTranslator } from '../../src/reader/selection/translator';
import { notices } from '../stubs/obsidian';

// ---- DOM: linkedom plus the few Obsidian element helpers the popup uses ----

interface ElementInfo { cls?: string; text?: string; attr?: Record<string, string> }

const XHTML = 'http://www.w3.org/1999/xhtml';

/** One `.leaf` container per PDF tab, laid out as Obsidian does; each content goes into its .view-content. */
function createDom(contents: readonly string[]) {
  const leaves = contents.map(content => `<div class="leaf"><div class="view-header"><div class="view-actions"></div></div><div class="view-content">${content}</div></div>`).join('');
  const { window, document, HTMLElement } = parseHTML(`<!doctype html><html><body>${leaves}<div class="elsewhere">Sidebar text.</div></body></html>`);
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

/** Reading layer per docs/contracts.md §6.1, including interface elements marked data-pw-ui. */
const READER = (active: boolean, lang: 'en' | 'zh') => `${NATIVE}
  <div class="pdf-reader-content" data-pdf-reader-active="${active}" data-lang="${lang}">
    <div data-pw-ui class="pw-reader-status">翻译中 3/10</div>
    <div class="pw-block" data-block-id="b1">
      <div class="pw-layer en1" lang="en"${lang === 'zh' ? ' aria-hidden="true"' : ''}>Soft actuators are compliant.<button data-pw-ui>原文 p.1</button><button data-pw-ui>复制页链</button></div>
      <div class="pw-layer zh1" lang="zh"${lang === 'en' ? ' aria-hidden="true"' : ''}>软执行器是柔顺的。<button data-pw-ui>原文 p.1</button></div>
    </div>
    <span data-pw-ui class="pw-page-marker">p. 2</span>
    <div data-pw-ui class="pw-fold">▸ References</div>
    <div class="pw-block" data-block-id="b2">
      <div class="pw-layer en2" lang="en"${lang === 'zh' ? ' aria-hidden="true"' : ''}>They are light.</div>
      <div class="pw-layer zh2" lang="zh"${lang === 'en' ? ' aria-hidden="true"' : ''}>它们很轻。<span data-pw-ui>缺译文</span></div>
    </div>
  </div>`;

function makeLeaf(containerEl: HTMLElement, file: string) {
  const handle = { file, type: 'pdf' };
  const leaf = { view: { containerEl, getViewType: () => handle.type, getState: () => ({ file: handle.file }) } } as unknown as WorkspaceLeaf;
  return { leaf, containerEl, handle };
}

/** linkedom has no Selection; this stands in for document.getSelection(). */
function select(document: Document, node: Node, text: string) {
  const rect = { left: 100, top: 100, right: 200, bottom: 120, width: 100, height: 20 };
  let clones = 0;
  const range = {
    commonAncestorContainer: node, startContainer: node, endContainer: node,
    cloneRange: () => range,
    cloneContents: () => { clones += 1; const real = document.createRange(); real.selectNode(node); return real.cloneContents(); },
    getClientRects: () => [rect],
    getBoundingClientRect: () => rect,
  } as unknown as Range;
  const selection = {
    isCollapsed: false, rangeCount: 1, cleared: false,
    get clones() { return clones; },
    getRangeAt: () => range,
    toString: () => text,
    removeAllRanges() { selection.rangeCount = 0; selection.cleared = true; },
  };
  (document as unknown as { getSelection: () => typeof selection }).getSelection = () => selection;
  return selection;
}

interface Pending { request: TranslateRequest; resolve(value: string): void; reject(error: Error): void }
type Command = { id: string; checkCallback(checking: boolean): boolean | void };

function harness(content: string | readonly string[] = NATIVE, options: { key?: string | null; glossary?: Term[] } = {}) {
  const contents = typeof content === 'string' ? [content] : content;
  const { window, document } = createDom(contents);
  (globalThis as unknown as { activeDocument: Document }).activeDocument = document;
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('.leaf'), (element, index) => makeLeaf(element, `papers/${index}.pdf`));
  const leaves: WorkspaceLeaf[] = tabs.map(tab => tab.leaf);
  const buttons: PdfToolbarButton[] = [];
  const commands: Command[] = [];
  const pending: Pending[] = [];
  const cleanups: Array<() => void> = [];
  const workspaceHandlers = new Map<string, (...args: unknown[]) => void>();
  let mostRecent: WorkspaceLeaf | null = null;
  let domListeners = 0;
  let auto = true;
  const events = new EventBus();
  const settings = readSettings(undefined);
  const core = { qwenMtEndpoint: '', glossary: options.glossary ?? [] };
  const context = {
    app: {
      workspace: {
        iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void) => leaves.forEach(callback),
        on: (name: string, callback: (...args: unknown[]) => void) => { workspaceHandlers.set(name, callback); return {}; },
        onLayoutReady: (callback: () => void) => callback(),
        getMostRecentLeaf: () => mostRecent,
      },
      vault: { configDir: '.obsidian', adapter: { exists: () => Promise.resolve(false), read: () => Promise.reject(new Error('no file')) } },
    },
    plugin: {
      addCommand: (command: Command) => { commands.push(command); },
      register: (cleanup: () => void) => { cleanups.push(cleanup); },
      registerEvent: () => {},
      registerDomEvent: (target: EventTarget, type: string, listener: EventListener, opts?: AddEventListenerOptions) => {
        target.addEventListener(type, listener, opts);
        domListeners += 1;
        cleanups.push(() => { target.removeEventListener(type, listener, opts); domListeners -= 1; });
      },
    },
    events,
    services: { pdfToolbar: { register: (button: PdfToolbarButton) => { buttons.push(button); return () => { buttons.splice(buttons.indexOf(button), 1); }; }, refresh: () => {} } },
    settings,
    saveSettings: () => Promise.resolve(),
    core,
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
  translator.refresh();
  const first = tabs[0]!;

  const dispatch = (target: EventTarget, type: string, init: Record<string, unknown> = {}) => {
    const event = new window.Event(type, { bubbles: true });
    Object.assign(event, init);
    target.dispatchEvent(event);
  };

  return {
    window, document, translator, tabs, leaves, events, settings, core, buttons, commands, pending, workspaceHandlers, dispatch,
    leaf: first.leaf, containerEl: first.containerEl, handle: first.handle,
    manual() { auto = false; },
    domListeners: () => domListeners,
    busListeners: (name: string) => (events as unknown as { listeners: Map<string, Set<unknown>> }).listeners.get(name)?.size ?? 0,
    setMostRecent(leaf: WorkspaceLeaf | null) { mostRecent = leaf; },
    enable(leaf: WorkspaceLeaf = first.leaf) { buttons[0]!.onClick(leaf, document.body.createEl('button')); },
    /** What Obsidian does on plugin unload: dispose, then run everything registered through the plugin. */
    unload() { translator.dispose(); for (const cleanup of cleanups.splice(0)) cleanup(); },
    popup: () => document.querySelector('.pw-selection-popup'),
    popups: () => document.querySelectorAll('.pw-selection-popup').length,
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
  h.dispatch(h.document, 'mouseup', { clientX: 150, clientY: 110 });
  assert.equal(h.pending.length, 0);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.pending.length, 1);
});

test('reading mode English layer translates; a selection across blocks drops the hidden Chinese and interface text', async () => {
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
  h.dispatch(h.document, 'keydown', { key: 'Escape' });
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

test('settings: a failed legacy read leaves the import pending for the next load', async () => {
  const settings = readSettings(undefined);
  const broken = { exists: () => Promise.resolve(true), read: () => Promise.resolve('{not json') };
  await assert.rejects(importLegacySettings(broken, '.obsidian', settings));
  assert.equal(settings.legacyImported, false);
  const missing = { exists: () => Promise.resolve(false), read: () => Promise.reject(new Error('unreachable')) };
  assert.equal(await importLegacySettings(missing, '.obsidian', settings), true);
  assert.equal(settings.legacyImported, true);
});

test('interface-only selections in the reading layer send nothing', async () => {
  const h = harness(READER(true, 'en'));
  h.enable();
  select(h.document, h.containerEl.querySelector('.pw-page-marker')!, 'p. 2');
  h.translator.handleSelection(h.document);
  await settle();
  assert.equal(h.pending.length, 0);
  assert.equal(h.popup(), null);
});

test('a reading-layer selection far past the limit is rejected before cloning the DOM', async () => {
  const h = harness(READER(true, 'en'));
  h.enable();
  h.settings.maxSelectionCharacters = 1_000;
  const selection = select(h.document, h.containerEl.querySelector('.pdf-reader-content')!, 'x'.repeat(2_500));
  h.translator.handleSelection(h.document);
  await settle();
  assert.equal(selection.clones, 0);
  assert.equal(h.pending.length, 0);
  assert.match(h.popupText(), /约 2,500 个字符，超过当前上限 1,000/);
});

test('the configured timeout is passed to the request', async () => {
  const h = harness();
  h.enable();
  h.settings.timeoutSeconds = 45;
  select(h.document, h.containerEl.querySelector('.native')!, 'Dielectric elastomers.');
  h.translator.handleSelection(h.document);
  await settle();
  assert.equal(h.pending[0]!.request.timeoutMs, 45_000);
});

test('keyboard selection (Shift+Arrow) triggers translation', async () => {
  const h = harness();
  h.enable();
  select(h.document, h.containerEl.querySelector('.native')!, 'Dielectric elastomers.');
  h.dispatch(h.document, 'keydown', { key: 'ArrowRight', shiftKey: true });
  assert.equal(h.pending.length, 0);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(h.pending.length, 1);
});

test('the command is available only while a PDF tab is active, checked on every call', () => {
  const h = harness();
  const command = h.commands[0]!;
  assert.equal(command.checkCallback(true), false, 'no active leaf yet');

  h.setMostRecent(h.leaf);
  h.workspaceHandlers.get('file-open')!(null);
  assert.equal(command.checkCallback(true), true);

  h.handle.type = 'markdown';
  assert.equal(command.checkCallback(true), false, 'same leaf now shows a note');
  h.handle.type = 'pdf';

  h.workspaceHandlers.get('active-leaf-change')!(null);
  assert.equal(command.checkCallback(true), false);
  h.workspaceHandlers.get('active-leaf-change')!(h.leaf);
  command.checkCallback(false);
  assert.equal(h.translator.isEnabled(h.leaf), true);
});

test('only one popup across tabs: a selection in another tab closes and cancels the first', () => {
  const h = harness([NATIVE, NATIVE]);
  h.manual();
  const [one, two] = h.tabs;
  h.enable(one!.leaf);
  h.enable(two!.leaf);
  select(h.document, one!.containerEl.querySelector('.native')!, 'First tab.');
  h.translator.handleSelection(h.document);
  select(h.document, two!.containerEl.querySelector('.native')!, 'Second tab.');
  h.translator.handleSelection(h.document);
  assert.equal(h.popups(), 1);
  assert.equal(h.pending[0]!.request.signal!.aborted, true);
  assert.equal(h.pending[1]!.request.text, 'Second tab.');
});

test('closing a tab removes its popup and cancels its request', () => {
  const h = harness([NATIVE, NATIVE]);
  h.manual();
  h.enable();
  select(h.document, h.containerEl.querySelector('.native')!, 'Dielectric elastomers.');
  h.translator.handleSelection(h.document);
  assert.ok(h.popup());
  h.leaves.splice(0, 1);
  h.translator.refresh();
  assert.equal(h.popup(), null);
  assert.equal(h.pending[0]!.request.signal!.aborted, true);
  assert.equal(h.translator.isEnabled(h.leaf), false);
});

test('pointer down outside the popup closes it; inside keeps it', async () => {
  const h = harness();
  h.enable();
  select(h.document, h.containerEl.querySelector('.native')!, 'Dielectric elastomers.');
  h.translator.handleSelection(h.document);
  await settle();
  h.dispatch(h.document.querySelector('.pw-selection-result')!, 'pointerdown');
  assert.ok(h.popup());
  h.dispatch(h.document.querySelector('.elsewhere')!, 'pointerdown');
  assert.equal(h.popup(), null);
});

test('retry sends the request again', async () => {
  const h = harness();
  h.manual();
  h.enable();
  select(h.document, h.containerEl.querySelector('.native')!, 'Dielectric elastomers.');
  h.translator.handleSelection(h.document);
  h.pending[0]!.reject(new Error('Qwen-MT 请求失败（503）'));
  await settle();
  h.document.querySelector<HTMLElement>('.pw-selection-retry')!.click();
  assert.equal(h.pending.length, 2);
  assert.equal(h.pending[1]!.request.text, 'Dielectric elastomers.');
  h.pending[1]!.resolve('介电弹性体。');
  await settle();
  assert.equal(h.popupText(), '介电弹性体。');
});

test('a glossary change for the selected text misses the cache; old entries are evicted after 100', async () => {
  const h = harness();
  h.enable();
  const node = h.containerEl.querySelector('.native')!;
  const translate = async (text: string) => {
    h.document.querySelector<HTMLElement>('.pw-selection-close')?.click();
    select(h.document, node, text);
    h.translator.handleSelection(h.document);
    await settle();
  };

  await translate('Dielectric elastomer film.');
  await translate('Dielectric elastomer film.');
  assert.equal(h.pending.length, 1);
  h.core.glossary.push({ source: 'dielectric elastomer', target: '介电弹性体' });
  await translate('Dielectric elastomer film.');
  assert.equal(h.pending.length, 2);
  h.core.glossary.push({ source: 'unrelated term', target: '无关' });
  await translate('Dielectric elastomer film.');
  assert.equal(h.pending.length, 2, 'terms not in the text do not affect the cache');

  for (let index = 0; index < 100; index++) await translate(`Sentence ${index}.`);
  assert.equal(h.pending.length, 102);
  await translate('Sentence 99.');
  assert.equal(h.pending.length, 102, 'recent entries stay');
  await translate('Dielectric elastomer film.');
  assert.equal(h.pending.length, 103, 'the oldest entry was evicted');
});

test('unload removes popups, cancels requests and stops listening', async () => {
  const h = harness();
  h.manual();
  h.enable();
  select(h.document, h.containerEl.querySelector('.native')!, 'Dielectric elastomers.');
  h.translator.handleSelection(h.document);
  const signal = h.pending[0]!.request.signal!;
  h.unload();
  assert.equal(h.popup(), null);
  assert.equal(signal.aborted, true);
  assert.equal(h.buttons.length, 0);
  assert.equal(h.domListeners(), 0);
  assert.equal(h.busListeners('reader:mode-change'), 0);

  h.dispatch(h.document, 'mouseup', { clientX: 1, clientY: 1 });
  h.events.emit('reader:mode-change', { leafId: leafId(h.leaf), active: true, language: 'en' });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.pending.length, 1);
});

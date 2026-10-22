import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { parseHTML } from 'linkedom';

/**
 * Reader code runs against Obsidian's DOM helpers (createEl, createDiv, …) and its
 * MathJax/sanitizer API. Tests use linkedom plus the small equivalents below, and
 * bundle each module with an `obsidian` stand-in whose behaviour a test can steer.
 */

export interface MathHarness {
  document: Document;
  calls: string[];
  loaded: boolean;
  invalidFormula?: string;
  failFlush?: boolean;
  mathIds?: boolean;
  notices: string[];
  modals: Array<{ kind: string; args: unknown[]; confirm?: () => void }>;
}

const shared = globalThis as typeof globalThis & { __readerHarness: MathHarness };

export function harness(): MathHarness { return shared.__readerHarness; }

const OBSIDIAN_STUB = `
const h = () => globalThis.__readerHarness;
export async function loadMathJax() { h().calls.push('load:start'); await Promise.resolve(); h().loaded = true; h().calls.push('load:ready'); }
export function renderMath(source, display) {
  const harness = h();
  if (!harness.loaded) throw new Error('MathJax not loaded');
  harness.calls.push('math:' + source);
  const node = harness.document.createElement('span');
  node.className = 'test-math'; node.dataset.source = source; node.dataset.display = String(display); node.textContent = source;
  if (harness.mathIds) {
    node.id = 'math-' + harness.calls.filter(call => call.startsWith('math:')).length;
    const link = harness.document.createElement('a'); link.setAttribute('href', '#' + node.id); node.append(link);
    const svg = harness.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const glyph = harness.document.createElementNS('http://www.w3.org/2000/svg', 'path'); glyph.id = node.id + '-glyph'; svg.append(glyph);
    const use = harness.document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + glyph.id);
    use.setAttribute('clip-path', 'url(#' + glyph.id + ')'); svg.append(use); node.append(svg);
    node.setAttribute('aria-labelledby', glyph.id);
  }
  if (source === harness.invalidFormula) { const error = harness.document.createElement('mjx-merror'); error.setAttribute('data-mjx-error', 'invalid TeX'); node.append(error); }
  return node;
}
export async function finishRenderMath() { h().calls.push('flush'); if (h().failFlush) throw new Error('stylesheet flush failed'); }
export function sanitizeHTMLToDom(html) { const template = h().document.createElement('template'); template.innerHTML = html; return template.content; }
export class Notice { constructor(message) { h().notices.push(message); } }
export class Modal {
  constructor(app, ...args) { this.app = app; this.args = args; this.contentEl = h().document.createElement('div'); this.modalEl = h().document.createElement('div'); }
  setTitle(title) { this.title = title; return this; }
  open() { const entry = { kind: this.constructor.name, args: this.args, modal: this }; h().modals.push(entry); this.onOpen?.(); }
  close() { this.onClose?.(); }
}
export class TFile {}
export class Setting {
  constructor() {} setName() { return this; } setDesc() { return this; } addSlider() { return this; } addToggle() { return this; }
}
export function setIcon() {}
`;

const cache = new Map<string, Promise<unknown>>();

/** Bundle a reader source file with the obsidian stand-in and import it. */
export function load<T>(relativeToRepo: string): Promise<T> {
  let module = cache.get(relativeToRepo);
  if (!module) {
    module = build({
      entryPoints: [new URL(`../../${relativeToRepo}`, import.meta.url).pathname],
      bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022',
      external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)],
      plugins: [{
        name: 'obsidian-test-api',
        setup(builder) {
          builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
          builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: OBSIDIAN_STUB }));
        },
      }],
    }).then(result => {
      const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`;
      // The bundle is built just above from this repository's own sources.
      // eslint-disable-next-line no-unsanitized/method -- trusted, locally built module
      return import(url) as Promise<unknown>;
    });
    cache.set(relativeToRepo, module);
  }
  return module as Promise<T>;
}

interface ElementInfo { cls?: string | string[]; text?: string; attr?: Record<string, string | number | boolean | null>; title?: string; type?: string; value?: string; placeholder?: string; prepend?: boolean }

let installed = false;

/** linkedom's own factory methods, which the helpers below are built on. */
function raw(document: Document): { createElement(tag: string): HTMLElement; createDocumentFragment(): DocumentFragment } {
  return document;
}

/** Obsidian's DOM additions, implemented on linkedom's shared prototypes. */
function installDomHelpers(sample: Document): void {
  if (installed) return;
  installed = true;
  // Every prototype that defines append(): elements, fragments and documents all get the helpers.
  const targets = new Set<object>();
  for (let proto: object | null = raw(sample).createElement('div'); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto) as object | null) targets.add(proto);
  for (let proto: object | null = raw(sample).createDocumentFragment(); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto) as object | null) targets.add(proto);
  const prototypes = [...targets].filter(proto => Object.prototype.hasOwnProperty.call(proto, 'append'));
  function createEl(this: Node, tag: string, info: ElementInfo | string = {}): HTMLElement {
    const options = typeof info === 'string' ? { cls: info } : info;
    const owner = this.nodeType === 9 ? this as Document : this.ownerDocument!;
    const created = raw(owner).createElement(tag);
    const classes = Array.isArray(options.cls) ? options.cls : options.cls?.split(' ') ?? [];
    for (const name of classes.filter(Boolean)) created.classList.add(name);
    if (options.text !== undefined) created.textContent = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) if (value !== null && value !== false) created.setAttribute(name, String(value));
    if (options.title !== undefined) created.setAttribute('title', options.title);
    if (options.type !== undefined) created.setAttribute('type', options.type);
    if (options.placeholder !== undefined) created.setAttribute('placeholder', options.placeholder);
    if (options.value !== undefined) (created as HTMLInputElement).value = options.value;
    if (options.prepend) (this as ParentNode).prepend(created); else (this as ParentNode).append(created);
    return created;
  }
  const helpers: Record<string, unknown> = {
    createEl,
    createDiv(this: Node, info?: ElementInfo | string) { return createEl.call(this, 'div', info); },
    createSpan(this: Node, info?: ElementInfo | string) { return createEl.call(this, 'span', info); },
    empty(this: Element) { while (this.firstChild) this.firstChild.remove(); },
    appendText(this: Element, text: string) { this.append(text); },
    setText(this: Element, text: string) { this.textContent = text; },
    addClass(this: Element, ...names: string[]) { this.classList.add(...names); },
    removeClass(this: Element, ...names: string[]) { this.classList.remove(...names); },
    toggleClass(this: Element, name: string, value: boolean) { this.classList.toggle(name, value); },
  };
  for (const [name, helper] of Object.entries(helpers)) {
    for (const target of prototypes) Object.defineProperty(target, name, { value: helper, configurable: true, writable: true });
  }
  // linkedom does no layout: geometry is zero unless a test overrides it per element.
  for (const target of new Set([...targets].filter(proto => 'setAttribute' in proto))) {
    if (!('getBoundingClientRect' in target)) Object.defineProperty(target, 'getBoundingClientRect', { value: () => rectangle(0, 0, 0), configurable: true, writable: true });
    if (!('scrollIntoView' in target)) Object.defineProperty(target, 'scrollIntoView', { value: () => {}, configurable: true, writable: true });
  }
  (globalThis as unknown as { createFragment: () => DocumentFragment }).createFragment = () => raw(shared.__readerHarness.document).createDocumentFragment();
}

/** A fresh linkedom document with Obsidian's helpers and a reset harness. */
export function dom(extra: Partial<MathHarness> = {}): { document: Document; window: Window & typeof globalThis; body: HTMLElement } {
  const { document: parsed, window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
  const document = parsed;
  installDomHelpers(document);
  shared.__readerHarness = { document, calls: [], loaded: false, notices: [], modals: [], ...extra };
  return { document, window, body: document.body };
}

export function rectangle(top: number, height = 80, width = 500): DOMRect {
  return { top, left: 0, right: width, bottom: top + height, width, height, x: 0, y: top, toJSON: () => ({}) };
}

/** Run `body` with every element's getBoundingClientRect answered by `geometry`. */
export function withGeometry<T>(sample: Element, geometry: (element: Element) => DOMRect, body: () => T): T {
  const replaced: Array<[object, PropertyDescriptor]> = [];
  for (let proto = Object.getPrototypeOf(sample) as object | null; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'getBoundingClientRect');
    if (!descriptor) continue;
    replaced.push([proto, descriptor]);
    Object.defineProperty(proto, 'getBoundingClientRect', { value: function (this: Element) { return geometry(this); }, configurable: true, writable: true });
  }
  try { return body(); }
  finally { for (const [proto, descriptor] of replaced) Object.defineProperty(proto, 'getBoundingClientRect', descriptor); }
}

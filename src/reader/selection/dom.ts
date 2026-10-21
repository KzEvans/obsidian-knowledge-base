import type { RectLike } from './geometry';

export interface PointerLocation {
  x: number;
  y: number;
}

/** Undo PDF line-break hyphenation and collapse layout whitespace. */
export function normalizePdfSelection(value: string): string {
  return value
    .replace(/­/g, '')
    .replace(/([\p{L}])-\s*\r?\n\s*(?=[\p{Ll}])/gu, '$1')
    .replace(/[\t ]+/g, ' ')
    .replace(/\s*\r?\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const READER_BREAKS = 'p, li, h1, h2, h3, h4, h5, h6, figcaption, .pw-block';

/**
 * Text of a selection in the reading layer. The hidden layer (aria-hidden) may sit inside the
 * range when it spans several blocks; it is dropped so only the visible English is sent.
 */
export function readerSelectionText(range: Range): string {
  const fragment = range.cloneContents();
  fragment.querySelectorAll('[aria-hidden="true"]').forEach(element => element.remove());
  fragment.querySelectorAll('br').forEach(element => element.replaceWith('\n'));
  fragment.querySelectorAll(READER_BREAKS).forEach(element => element.append('\n'));
  return Array.from(fragment.childNodes, node => node.textContent ?? '').join('');
}

/** True when the node sits in an aria-hidden subtree below `root` (the reading layer's inactive language). */
export function isInHiddenLayer(node: Node, root: Element): boolean {
  const element = node.nodeType === 1 ? node as Element : node.parentElement;
  const hidden = element?.closest('[aria-hidden="true"]');
  return !!hidden && root.contains(hidden);
}

export function chooseRangeRect(range: Range, pointer?: PointerLocation): RectLike | null {
  const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) {
    const rect = range.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 ? rect : null;
  }

  if (!pointer) return rects[rects.length - 1] ?? null;
  return rects.reduce((closest, rect) => {
    const distance = distanceToRect(pointer, rect);
    return distance < closest.distance ? { rect, distance } : closest;
  }, { rect: rects[0]!, distance: distanceToRect(pointer, rects[0]!) }).rect;
}

function distanceToRect(point: PointerLocation, rect: RectLike): number {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
  const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
  return dx * dx + dy * dy;
}

/** Translate a rect from a (possibly nested) iframe's viewport into `targetDocument`'s viewport. */
export function convertRectToDocument(rect: RectLike, sourceDocument: Document, targetDocument: Document): RectLike | null {
  let left = rect.left;
  let top = rect.top;
  let currentDocument: Document | null = sourceDocument;

  while (currentDocument && currentDocument !== targetDocument) {
    const frame: Element | null = currentDocument.defaultView?.frameElement ?? null;
    if (!frame) return null;
    const frameRect = frame.getBoundingClientRect();
    left += frameRect.left;
    top += frameRect.top;
    currentDocument = frame.ownerDocument;
  }
  if (currentDocument !== targetDocument) return null;

  return { left, top, right: left + rect.width, bottom: top + rect.height, width: rect.width, height: rect.height };
}

/** Containment that also follows iframes up to the view's document. */
export function isNodeInsideView(node: Node, viewContainer: HTMLElement): boolean {
  let currentNode: Node | null = node;
  let currentDocument: Document | null = node.ownerDocument;

  while (currentNode && currentDocument) {
    if (currentDocument === viewContainer.ownerDocument) return viewContainer.contains(currentNode);
    const frame: Element | null = currentDocument.defaultView?.frameElement ?? null;
    if (!frame) return false;
    currentNode = frame;
    currentDocument = frame.ownerDocument;
  }
  return false;
}

export function isNode(target: EventTarget | null): target is Node {
  return target !== null && typeof (target as Node).nodeType === 'number';
}

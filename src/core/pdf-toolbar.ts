import { setIcon } from 'obsidian';
import type { App, Plugin, WorkspaceLeaf } from 'obsidian';
import type { PdfToolbar, PdfToolbarButton } from './services';

const BUTTON_CLASS = 'paper-workbench-pdf-action';

/**
 * Native PDF views have no public toolbar API; buttons go into `.view-actions`.
 * Ours are kept together at the start, sorted by `order`, so reading mode and
 * translation always sit side by side.
 */
export function createPdfToolbar(app: App, plugin: Plugin): PdfToolbar {
  const buttons = new Map<string, PdfToolbarButton>();
  const placed = new WeakMap<WorkspaceLeaf, Map<string, HTMLElement>>();
  let timer = 0;

  const refreshNow = () => {
    app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view.getViewType() !== 'pdf') return;
      const actions = leaf.view.containerEl.querySelector<HTMLElement>('.view-actions');
      if (!actions) return;
      let elements = placed.get(leaf);
      if (!elements) { elements = new Map(); placed.set(leaf, elements); }
      for (const [id, element] of elements) {
        if (!buttons.has(id) || !element.isConnected || element.parentElement !== actions) { element.remove(); elements.delete(id); }
      }
      const ordered = [...buttons.values()].sort((left, right) => left.order - right.order);
      for (const button of ordered) {
        let element = elements.get(button.id);
        if (!element) {
          element = actions.createEl('button', { cls: `clickable-icon ${BUTTON_CLASS}`, attr: { type: 'button', 'aria-label': button.label, 'data-pw-button': button.id } });
          setIcon(element, button.icon);
          const target = element;
          plugin.registerDomEvent(element, 'click', event => { event.preventDefault(); event.stopPropagation(); button.onClick(leaf, target); });
          elements.set(button.id, element);
        }
        button.update?.(leaf, element);
      }
      // Re-insert at the front in order; appendChild/insertBefore moves existing nodes.
      let anchor: ChildNode | null = actions.firstChild;
      for (const button of ordered) {
        const element = elements.get(button.id)!;
        if (element !== anchor) actions.insertBefore(element, anchor);
        anchor = element.nextSibling;
      }
    });
  };

  const queue = () => { window.clearTimeout(timer); timer = window.setTimeout(refreshNow, 60); };
  plugin.registerEvent(app.workspace.on('layout-change', queue));
  plugin.registerEvent(app.workspace.on('active-leaf-change', queue));
  plugin.registerEvent(app.workspace.on('file-open', queue));
  plugin.register(() => {
    window.clearTimeout(timer);
    buttons.clear();
    activeDocument.querySelectorAll(`.${BUTTON_CLASS}`).forEach(element => element.remove());
  });
  app.workspace.onLayoutReady(refreshNow);

  return {
    register(button) {
      if (buttons.has(button.id)) throw new Error(`工具栏按钮重复登记：${button.id}`);
      buttons.set(button.id, button);
      queue();
      return () => { buttons.delete(button.id); queue(); };
    },
    refresh: refreshNow,
  };
}

const leafIds = new WeakMap<WorkspaceLeaf, string>();
let nextLeafId = 1;

/** A stable id for a leaf during this session, for event payloads. */
export function leafId(leaf: WorkspaceLeaf): string {
  let id = leafIds.get(leaf);
  if (!id) { id = `leaf-${nextLeafId++}`; leafIds.set(leaf, id); }
  return id;
}

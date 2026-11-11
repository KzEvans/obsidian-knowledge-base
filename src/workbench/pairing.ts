import { FileView } from 'obsidian';
import type { App, Plugin, TFile, WorkspaceLeaf } from 'obsidian';

/** A note leaf on the left and its PDF leaf on the right. */
export interface Pair { note: WorkspaceLeaf; pdf: WorkspaceLeaf }

/**
 * Paired reading: opening a paper's PDF opens its note to the left; opening a paper note opens its PDF to the right.
 * Once a pair exists, opening another paper in either pane swaps both panes instead of splitting again.
 */
export class Pairing {
  private pairs: Pair[] = [];
  private busy = false;

  constructor(private readonly app: App, private readonly partners: (path: string) => { note: string; pdf: string } | undefined) {}

  start(plugin: Plugin): void {
    plugin.registerEvent(this.app.workspace.on('file-open', file => { if (file) void this.onOpen(file); }));
    plugin.registerEvent(this.app.workspace.on('layout-change', () => this.prune()));
  }

  /** The pair a leaf belongs to, on either side. */
  pairOf(leaf: WorkspaceLeaf): Pair | undefined {
    this.prune();
    return this.pairs.find(p => p.note === leaf || p.pdf === leaf);
  }

  private async onOpen(file: TFile): Promise<void> {
    if (this.busy) return;
    const { workspace } = this.app;
    const leaf = workspace.getMostRecentLeaf();
    if (!leaf || fileIn(leaf) !== file.path) return;
    const paths = this.partners(file.path);
    const note = paths && this.app.vault.getFileByPath(paths.note);
    const pdf = paths && this.app.vault.getFileByPath(paths.pdf);
    if (!note || !pdf) return;
    const openedPdf = file.path === pdf.path;

    this.prune();
    let pair = this.pairs.find(p => p.note === leaf || p.pdf === leaf);
    if (!pair) {
      if (this.isOpen(openedPdf ? note : pdf)) return; // the user already has both on screen
      const other = workspace.createLeafBySplit(leaf, 'vertical', openedPdf);
      pair = openedPdf ? { note: other, pdf: leaf } : { note: leaf, pdf: other };
      this.pairs.push(pair);
    }
    this.busy = true;
    try {
      // A PDF opened in the note pane (or the reverse) moves to its side; both panes then show this paper.
      await show(pair.note, note);
      await show(pair.pdf, pdf);
      workspace.setActiveLeaf(openedPdf ? pair.pdf : pair.note, { focus: true });
    } finally {
      this.busy = false;
    }
  }

  private isOpen(file: TFile): boolean {
    let found = false;
    this.app.workspace.iterateRootLeaves(leaf => { found ||= fileIn(leaf) === file.path; });
    return found;
  }

  /** Forget pairs whose panes were closed. */
  private prune(): void {
    const attached = new Set<WorkspaceLeaf>();
    this.app.workspace.iterateRootLeaves(leaf => { attached.add(leaf); });
    this.pairs = this.pairs.filter(p => attached.has(p.note) && attached.has(p.pdf));
  }
}

function fileIn(leaf: WorkspaceLeaf): string | undefined {
  return leaf.view instanceof FileView ? leaf.view.file?.path : undefined;
}

async function show(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
  if (fileIn(leaf) !== file.path) await leaf.openFile(file, { active: false });
}

import type { App, Plugin, TAbstractFile } from 'obsidian';
import type { Logger } from '../core/log';
import { MANIFEST_PATH, NOTES_ROOT, buildPapers, noteInfo, pairIndex } from './model';
import type { Paper } from './model';

/** The Zotero manifest joined with paper notes, rebuilt when either changes. */
export class LibraryData {
  papers: Paper[] = [];
  private pdfFor = new Map<string, string>();
  private noteFor = new Map<string, string>();
  private listeners = new Set<() => void>();
  private timer: number | undefined;

  constructor(private readonly app: App, private readonly log: Logger) {}

  start(plugin: Plugin): void {
    this.app.workspace.onLayoutReady(() => {
      const relevant = (file: TAbstractFile) => file.path === MANIFEST_PATH || file.path.startsWith(`${NOTES_ROOT}/`);
      const onChange = (file: TAbstractFile) => { if (relevant(file)) this.schedule(); };
      plugin.registerEvent(this.app.vault.on('modify', file => { if (file.path === MANIFEST_PATH) this.schedule(); }));
      plugin.registerEvent(this.app.vault.on('create', onChange));
      plugin.registerEvent(this.app.vault.on('delete', onChange));
      plugin.registerEvent(this.app.vault.on('rename', (file, old) => { if (relevant(file) || old.startsWith(`${NOTES_ROOT}/`)) this.schedule(); }));
      plugin.registerEvent(this.app.metadataCache.on('changed', onChange));
      void this.load();
    });
  }

  dispose(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.listeners.clear();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Note and PDF of the paper behind a vault path, if it is either one. */
  partners(path: string): { note: string; pdf: string } | undefined {
    const pdf = this.pdfFor.get(path);
    if (pdf) return { note: path, pdf };
    const note = this.noteFor.get(path);
    return note ? { note, pdf: path } : undefined;
  }

  private schedule(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = undefined; void this.load(); }, 300);
  }

  private async load(): Promise<void> {
    let manifest: unknown = null;
    try {
      manifest = JSON.parse(await this.app.vault.adapter.read(MANIFEST_PATH));
    } catch (error) {
      this.log.warn('读取 Zotero 清单失败，文献库只显示笔记配对', error);
    }
    const { metadataCache } = this.app;
    const notes = this.app.vault.getMarkdownFiles().flatMap(file => {
      const info = noteInfo(file.path, metadataCache.getFileCache(file)?.frontmatter, link => metadataCache.getFirstLinkpathDest(link, file.path)?.path);
      return info ? [info] : [];
    });
    this.papers = buildPapers(manifest, notes);
    ({ pdfFor: this.pdfFor, noteFor: this.noteFor } = pairIndex(this.papers, notes));
    for (const listener of this.listeners) listener();
  }
}

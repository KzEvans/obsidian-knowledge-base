import type { WorkspaceLeaf } from 'obsidian';
import type { Manifest } from './types';

/**
 * Requests between modules (architecture §3.7). A provider registers its implementation
 * during register(); users must handle `undefined` when the provider is not loaded.
 */

/** Provided by library. */
export interface PipelineControl {
  status(sha: string): Promise<Manifest | undefined>;
  /** For a PDF outside the library; the reader asks you before calling. */
  requestParse(vaultPath: string): Promise<void>;
  prioritize(sha: string): void;
  retry(sha: string): void;
  cancel(sha: string): void;
}

/** Provided by agent; used by library for impact-factor lookup. */
export interface AgentRunner {
  runReadOnly(prompt: string, options: { timeoutMs: number; signal?: AbortSignal; outputSchema?: object; allowWebSearch?: boolean }): Promise<string>;
}

export interface PdfToolbarButton {
  id: string;
  /** Lower comes first: reading mode 10, translation 20. */
  order: number;
  icon: string;
  label: string;
  onClick(leaf: WorkspaceLeaf, button: HTMLElement): void;
  /** Called on every refresh so a button can reflect its leaf's state. */
  update?(leaf: WorkspaceLeaf, button: HTMLElement): void;
}

/** Provided by core: places buttons in the native PDF view's header in a fixed order. */
export interface PdfToolbar {
  register(button: PdfToolbarButton): () => void;
  /** Re-run update() for every button on every PDF leaf. */
  refresh(): void;
}

export interface Services {
  pipeline?: PipelineControl;
  agent?: AgentRunner;
  pdfToolbar: PdfToolbar;
}

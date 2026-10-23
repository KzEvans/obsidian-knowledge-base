export type ReaderBlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "figure"
  | "table"
  | "equation"
  | "footnote"
  | "metadata"
  | "references"
  | "header"
  | "footer";

/** Original PDF location: page is one-based; bbox is normalized, top-left origin. */
export interface SourceRef {
  page: number;
  bbox?: [number, number, number, number];
}

export interface ReaderBlock {
  id: string;
  kind: ReaderBlockKind;
  sources: SourceRef[];
  /** Provider HTML is untrusted and must be sanitized by the renderer. */
  html?: string;
  text: string;
  level?: number;
  /** Relative member path in the parser's result ZIP. */
  asset?: string;
  captions?: string[];
  footnotes?: string[];
  hiddenByDefault?: boolean;
}

export interface ReaderDocument {
  schemaVersion: 1;
  sourceHash: string;
  parserSignature: string;
  pageCount: number;
  blocks: ReaderBlock[];
  warnings: string[];
}

// ---- Parse store (docs/contracts.md §2–4) ----

export const STAGES = ['discovered', 'copied', 'uploading', 'parsing', 'normalizing', 'translating', 'ready', 'failed', 'conflict'] as const;
export type Stage = typeof STAGES[number];

export interface StageFailure {
  stage: Stage;
  /** Already redacted. */
  error: string;
  attempts: number;
  at: string;
  retryable: boolean;
}

export interface ManifestSource {
  path: string;
  zoteroAttachmentKey?: string;
  zoteroParentKey?: string;
  inLibrary: boolean;
}

export interface Manifest {
  schemaVersion: 1;
  sha256: string;
  pageCount?: number;
  sources: ManifestSource[];
  stage: Stage;
  failure: StageFailure | null;
  priority: boolean;
  mineru?: {
    batchId?: string;
    previousBatchIds?: string[];
    modelVersion: 'vlm';
    options: { enable_formula: boolean; enable_table: boolean; language: string };
    uploadedAt?: string;
    completedAt?: string;
    origin: 'cloud' | 'imported-reader-cache';
  };
  raw?: { files: Record<string, string>; complete: boolean };
  normalized?: { normalizerVersion: number; at: string };
  translation?: { model: string; total: number; done: number; failed: number; at: string };
  updatedAt: string;
}

export interface Segment {
  field: 'text' | 'caption' | 'footnote';
  /** Index into captions/footnotes; 0 for text. */
  index: number;
  sourceHash: string;
}

export interface StoredBlock extends ReaderBlock {
  role?: 'abstract';
  translatable: boolean;
  segments?: Segment[];
}

export interface StoredAsset { path: string; width?: number; height?: number }

export interface StoredDocument {
  schemaVersion: 2;
  sha256: string;
  normalizerVersion: number;
  pageCount: number;
  blocks: StoredBlock[];
  warnings: string[];
  /** Keyed by the block's `asset` reference; `path` is relative to the paper directory. */
  assets: Record<string, StoredAsset>;
}

export interface TranslationEntry {
  text: string;
  model: string;
  termsKey: string;
  at: string;
  /** TRANSLATOR_VERSION that produced it; absent means 1. */
  translator?: number;
}
export interface TranslationFailure { error: string; attempts: number; at: string; translator?: number }

export interface TranslationFile {
  schemaVersion: 1;
  entries: Record<string, TranslationEntry>;
  failures: Record<string, TranslationFailure>;
}

export interface Term { source: string; target: string }

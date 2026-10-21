/**
 * The only place for types that Obsidian and its bundled pdf.js do not publish.
 * Keep these structural and minimal: describe just what this plugin reads.
 */

export interface PdfTextItem {
  str: string;
  width: number;
  height: number;
  transform: number[];
  fontName?: string;
}

export interface PdfViewport {
  width: number;
  height: number;
  scale: number;
  /** pdf.js returns a plain two-element array. */
  convertToViewportPoint(x: number, y: number): number[];
}

export interface PdfRenderTask { promise: Promise<void> }

export interface PdfPage {
  getTextContent(): Promise<{ items?: readonly unknown[] }>;
  getViewport(options: { scale: number }): PdfViewport;
  render(options: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: PdfViewport; intent?: string }): PdfRenderTask;
  cleanup(): void;
}

export interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

export interface PdfJs {
  version?: string;
  getDocument(options: Record<string, unknown> & { data: Uint8Array }): { promise: Promise<PdfDocument> };
}

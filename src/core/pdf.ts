import { loadPdfJs } from 'obsidian';
import type { PdfDocument, PdfJs } from './obsidian-internal';

/** Obsidian serves pdf.js resources under /lib/pdfjs/; eval stays off. */
export const PDF_RESOURCE_OPTIONS = {
  cMapUrl: '/lib/pdfjs/cmaps/', cMapPacked: true,
  standardFontDataUrl: '/lib/pdfjs/standard_fonts/', wasmUrl: '/lib/pdfjs/wasm/', iccUrl: '/lib/pdfjs/iccs/',
  isEvalSupported: false, useSystemFonts: true,
} as const;

/** Open PDF bytes with Obsidian's bundled pdf.js. The caller must destroy() the result. */
export async function openPdf(bytes: ArrayBuffer | Uint8Array): Promise<PdfDocument> {
  const pdfjs = await loadPdfJs() as PdfJs;
  // pdf.js transfers the buffer to its worker; pass a copy so the caller's bytes stay usable.
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes.slice(0));
  return pdfjs.getDocument({ ...PDF_RESOURCE_OPTIONS, data }).promise;
}

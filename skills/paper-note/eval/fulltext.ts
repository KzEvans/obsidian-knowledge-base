/**
 * Offline input for the evaluation: rebuild a paper's document from its old MinerU
 * cache with core's derive(). The full-text format lives in ../fulltext.ts.
 * Nothing is uploaded; crops are not drawn (figures are referenced by caption only).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { derive } from '../../../src/core/derive';
import type { AuditPdf } from '../../../src/core/audit';
import type { StoredDocument } from '../../../src/core/types';

const NOT_RAW = /^(?:result\.json|performance\.json|job\.json|fallback(?:-v2)?\/|source-tables-v1\/)/;

export async function deriveFromCache(cacheDirectory: string, pdfFile: string, sha: string): Promise<StoredDocument> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const entries = (await fs.readdir(cacheDirectory, { recursive: true })).filter(entry => !NOT_RAW.test(entry));
  const files: string[] = [];
  for (const entry of entries) if ((await fs.stat(path.join(cacheDirectory, entry))).isFile()) files.push(entry);
  const data = new Uint8Array(await fs.readFile(pdfFile));
  const pdf = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise as AuditPdf & { destroy(): Promise<void> };
  try {
    const { document } = await derive({
      sha, pdf,
      raw: { names: files, read: async entry => new Uint8Array(await fs.readFile(path.join(cacheDirectory, entry))) },
      existingDerived: async asset => { try { return new Uint8Array(await fs.readFile(path.join(cacheDirectory, asset))); } catch { return undefined; } },
      cropper: { cropPage: async (_page, requests) => new Map(requests.map(request => [request.blockId, { png: new Uint8Array(), width: 1, height: 1 }])) },
    });
    return document;
  } finally {
    await pdf.destroy();
  }
}

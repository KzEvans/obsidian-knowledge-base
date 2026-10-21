/**
 * Offline input for the evaluation: rebuild a paper's document from its old MinerU
 * cache with core's derive() and render it as plain Markdown without page numbers.
 * Nothing is uploaded; crops are not drawn (figures are referenced by caption only).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { derive } from '../../../src/core/derive';
import type { AuditPdf } from '../../../src/core/audit';
import type { StoredBlock, StoredDocument } from '../../../src/core/types';

const NOT_RAW = /^(?:result\.json|performance\.json|job\.json|fallback(?:-v2)?\/|source-tables-v1\/)/;

const plain = (html: string) => html
  .replace(/<sup>(.*?)<\/sup>/g, '^$1').replace(/<sub>(.*?)<\/sub>/g, '_$1')
  .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/[ \t]+/g, ' ').trim();

function tableText(html: string): string {
  return html.split(/<\/tr>/i).map(row => row.split(/<\/t[dh]>/i).map(plain).filter(Boolean).join(' | ')).filter(Boolean).join('\n');
}

function renderBlock(block: StoredBlock): string | undefined {
  const text = plain(block.text);
  switch (block.kind) {
    case 'heading': return `${'#'.repeat(Math.min(6, (block.level ?? 1) + 1))} ${text}`;
    case 'paragraph': case 'list': case 'footnote': return block.role === 'abstract' ? `[摘要] ${text}` : text;
    case 'equation': return text ? `$$${text}$$` : undefined;
    case 'figure': case 'table': {
      const parts = [...(block.captions ?? []).map(plain)];
      if (block.kind === 'table' && block.html) parts.push(tableText(block.html));
      else if (text) parts.push(text);
      parts.push(...(block.footnotes ?? []).map(plain));
      const body = parts.filter(Boolean).join('\n');
      return body ? `[${block.kind === 'table' ? '表' : '图'}] ${body}` : undefined;
    }
    case 'references': return text ? `[参考文献] ${text}` : undefined;
    default: return undefined;
  }
}

/** The normalized full text handed to the CLI: Markdown, figure/table captions kept, no page numbers. */
export function fullText(document: StoredDocument): string {
  return document.blocks.map(renderBlock).filter((part): part is string => !!part).join('\n\n') + '\n';
}

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

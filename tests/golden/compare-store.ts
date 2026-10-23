/**
 * Local diagnostic, not a test: re-derive every paper in a vault's parse store with the
 * current rules and report what changed against the stored document.json. Read-only.
 *   PAPER_WORKBENCH_VAULT="<vault>" pnpm exec tsx --import ./tests/setup.ts tests/golden/compare-store.ts
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { derive } from '../../src/core/derive';
import type { AuditPdf } from '../../src/core/audit';
import type { ReaderBlock, StoredDocument } from '../../src/core/types';

const vault = process.env.PAPER_WORKBENCH_VAULT;
const print = (line: string) => { process.stdout.write(line + '\n'); };
if (!vault) throw new Error('PAPER_WORKBENCH_VAULT not set');
const root = path.join(vault, '.research', 'papers');
const index = JSON.parse(await fs.readFile(path.join(vault, '.research', 'index.json'), 'utf8')) as { paths: Record<string, string> };
const plain = (text: string) => text.replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

function duplicates(blocks: ReaderBlock[]): string[] {
  const prose = blocks.filter(block => block.kind === 'paragraph' && !block.hiddenByDefault).map(block => ({ id: block.id, text: plain(block.text) }));
  const found: string[] = [];
  for (const a of prose) {
    if (a.text.length < 60) continue;
    const owner = prose.find(b => b !== a && b.text.length > a.text.length && b.text.includes(a.text.slice(0, Math.min(200, a.text.length))));
    if (owner) found.push(`${a.id}⊂${owner.id}`);
  }
  return found;
}

for (const sha of await fs.readdir(root)) {
  const dir = path.join(root, sha);
  let stored: StoredDocument;
  try { stored = JSON.parse(await fs.readFile(path.join(dir, 'document.json'), 'utf8')) as StoredDocument; } catch { continue; }
  const pdfPath = Object.entries(index.paths).find(([, value]) => value === sha)?.[0];
  if (!pdfPath) continue;
  const names = (await fs.readdir(path.join(dir, 'raw'), { recursive: true })).filter(name => !name.endsWith('.json') || name.includes('content_list') || name === 'layout.json' || name.endsWith('_model.json'));
  const files: string[] = [];
  for (const name of names) if ((await fs.stat(path.join(dir, 'raw', name))).isFile()) files.push(name);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(path.join(vault, pdfPath))), useSystemFonts: true, isEvalSupported: false }).promise as AuditPdf & { destroy(): Promise<void> };
  try {
    const { document } = await derive({
      sha, pdf,
      raw: { names: files, read: async name => new Uint8Array(await fs.readFile(path.join(dir, 'raw', name))) },
      existingDerived: async asset => { try { return new Uint8Array(await fs.readFile(path.join(dir, 'derived', asset))); } catch { return undefined; } },
      cropper: { cropPage: async (_page, requests) => new Map(requests.map(request => [request.blockId, { png: new Uint8Array(), width: 1, height: 1 }])) },
    });
    const visible = (doc: StoredDocument) => doc.blocks.filter(block => !block.hiddenByDefault);
    const newlyHidden = stored.blocks.filter(old => !old.hiddenByDefault && document.blocks.find(block => block.id === old.id)?.hiddenByDefault);
    const removed = stored.blocks.filter(old => !document.blocks.some(block => block.id === old.id));
    print(`\n## ${path.basename(pdfPath).slice(0, 70)}`);
    print(`visible blocks ${visible(stored).length} → ${visible(document).length}; duplicates before ${duplicates(stored.blocks).length} → after ${duplicates(document.blocks).join(' ') || 0}`);
    for (const block of newlyHidden) print(`  folded   ${block.id} p${block.sources[0]?.page} ${block.kind}: ${block.text.slice(0, 90).replace(/\n/g, ' ')}`);
    for (const block of removed) {
      const head = plain(block.text).slice(0, 80);
      const host = document.blocks.find(candidate => plain(candidate.text).includes(head));
      print(`  removed  ${block.id} p${block.sources[0]?.page} ${block.kind} → ${host ? `kept in ${host.id}` : 'TEXT LOST'}: ${block.text.slice(0, 70).replace(/\n/g, ' ')}`);
    }
    print(`  warnings ${stored.warnings.length} → ${document.warnings.length}`);
    const suspect = /https?:\/\/|www\.|©|copyright|licen[cs]e|downloaded|issn|doi\s*:|terms and conditions|journal homepage|contents lists|check for updates|reprints|permissions|^\s*\d+\s*(?:of\s*\d+)?\s*$/i;
    for (const block of document.blocks) {
      if (block.hiddenByDefault) continue;
      const text = block.text.replace(/<[^>]*>/g, '');
      const box = block.sources[0]?.bbox;
      const tinyImage = block.kind === 'figure' && !block.captions?.length && box && (box[2] - box[0]) * (box[3] - box[1]) < 0.01;
      const shortLine = block.kind === 'paragraph' && text.length < 40 && !/[.。]$/.test(text);
      if ((block.kind !== 'references' && suspect.test(text)) || tinyImage || shortLine) {
        print(`  SUSPECT  ${block.id} p${block.sources[0]?.page} ${block.kind}${tinyImage ? ' tiny-image' : ''}: ${text.slice(0, 110).replace(/\n/g, ' ')}`);
      }
    }
  } finally { await pdf.destroy(); }
}

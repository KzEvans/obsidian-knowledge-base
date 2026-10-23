/**
 * Real-paper checks against the parse store. Runs only when PAPER_WORKBENCH_VAULT points
 * at a vault; papers and results never enter the repo. Read-only.
 *
 *   PAPER_WORKBENCH_VAULT="<vault>" pnpm test
 *
 * For every stored paper, derive() with the current rules must
 *  - leave no paragraph that repeats the start of another (cross-column duplicates), and
 *  - keep the words of every block it merges away somewhere in the new document.
 */
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { derive } from '../../src/core/derive';
import type { AuditPdf } from '../../src/core/audit';
import type { ReaderBlock, StoredDocument } from '../../src/core/types';

const vault = process.env.PAPER_WORKBENCH_VAULT;
const compact = (text: string) => text.replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const words = (text: string) => (text.replace(/<[^>]*>|\$[^$]*\$/g, ' ').match(/[A-Za-z]{5,}/g) ?? []).map(word => word.toLowerCase());

function duplicates(blocks: readonly ReaderBlock[]): string[] {
  const prose = blocks.filter(block => block.kind === 'paragraph' && !block.hiddenByDefault).map(block => ({ id: block.id, text: compact(block.text) }));
  return prose.filter(a => a.text.length >= 60 && prose.some(b => b !== a && b.text.length > a.text.length && b.text.includes(a.text.slice(0, 200))))
    .map(block => block.id);
}

test('re-derived real papers have no repeated paragraphs and lose no merged text', { skip: !vault && 'PAPER_WORKBENCH_VAULT not set' }, async () => {
  const research = path.join(vault!, '.research');
  const index = JSON.parse(await fs.readFile(path.join(research, 'index.json'), 'utf8')) as { paths: Record<string, string> };
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let checked = 0;
  for (const sha of await fs.readdir(path.join(research, 'papers'))) {
    const directory = path.join(research, 'papers', sha);
    let stored: StoredDocument;
    try { stored = JSON.parse(await fs.readFile(path.join(directory, 'document.json'), 'utf8')) as StoredDocument; } catch { continue; }
    const pdfPath = Object.entries(index.paths).find(([, value]) => value === sha)?.[0];
    if (!pdfPath) continue;
    const names: string[] = [];
    for (const name of await fs.readdir(path.join(directory, 'raw'), { recursive: true })) {
      if ((await fs.stat(path.join(directory, 'raw', name))).isFile()) names.push(name);
    }
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(path.join(vault!, pdfPath))), useSystemFonts: true, isEvalSupported: false })
      .promise as unknown as AuditPdf & { destroy(): Promise<void> };
    try {
      const { document } = await derive({
        sha, pdf,
        raw: { names, read: async name => new Uint8Array(await fs.readFile(path.join(directory, 'raw', name))) },
        existingDerived: async asset => { try { return new Uint8Array(await fs.readFile(path.join(directory, 'derived', asset))); } catch { return undefined; } },
        cropper: { cropPage: async (_page, requests) => new Map(requests.map(request => [request.blockId, { png: new Uint8Array(), width: 1, height: 1 }])) },
      });
      assert.deepEqual(duplicates(document.blocks), [], `repeated paragraphs in ${pdfPath}`);
      const newWords = new Set(document.blocks.flatMap(block => words([block.text, ...(block.captions ?? [])].join(' '))));
      for (const old of stored.blocks) {
        if (old.hiddenByDefault || document.blocks.some(block => block.id === old.id)) continue;
        const sample = words(old.text).slice(0, 8);
        const missing = sample.filter(word => !newWords.has(word));
        assert.ok(missing.length <= Math.floor(sample.length / 4), `${pdfPath} ${old.id} lost text: ${missing.join(', ')}`);
      }
      checked++;
    } finally {
      await pdf.destroy();
    }
  }
  assert.ok(checked > 0, 'no stored paper found');
});

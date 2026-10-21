/**
 * Parity with the old reader on real cached papers. Runs only when
 * PAPER_WORKBENCH_VAULT points at a vault; papers and results never enter the repo.
 *
 *   PAPER_WORKBENCH_VAULT="<vault>" pnpm test
 *
 * For each old cache built by the current rule set (reader-v11), core's derive()
 * must reproduce the old document blocks and warnings exactly.
 */
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { derive } from '../../src/core/derive';
import type { AuditPdf } from '../../src/core/audit';
import type { ReaderBlock } from '../../src/core/types';

const vault = process.env.PAPER_WORKBENCH_VAULT;
const CURRENT_LEGACY_SIGNATURE = 'mineru-cloud-vlm-content-list-v1-reader-v11';
const NOT_RAW = /^(?:result\.json|performance\.json|job\.json|fallback(?:-v2)?\/|source-tables-v1\/)/;

interface LegacyResult { document: { parserSignature: string; blocks: ReaderBlock[]; warnings: string[]; pageCount: number } }

async function pdfPaths(root: string): Promise<Map<string, string>> {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'sources/literature/manifests/zotero-doc.json'), 'utf8')) as { items: Array<{ sha256: string; destination: string }> };
  return new Map(manifest.items.map(item => [item.sha256, path.join(root, item.destination)]));
}

async function openPdf(file: string): Promise<AuditPdf & { destroy(): Promise<void> }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(file));
  return pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
}

const comparable = (block: ReaderBlock) => ({
  id: block.id, kind: block.kind, text: block.text, html: block.html, level: block.level, sources: block.sources,
  captions: block.captions, footnotes: block.footnotes, hiddenByDefault: block.hiddenByDefault,
  // Old crops lived in the reader; derive names them identically.
  asset: block.asset,
});

test('derive reproduces the old reader on real papers', { skip: !vault && 'PAPER_WORKBENCH_VAULT not set' }, async () => {
  const root = vault!;
  const cacheRoot = path.join(root, '.obsidian/plugins/pdf-reading-mode/cache');
  const pdfs = await pdfPaths(root);
  let compared = 0;
  for (const name of await fs.readdir(cacheRoot)) {
    const directory = path.join(cacheRoot, name);
    let legacy: LegacyResult;
    try { legacy = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8')) as LegacyResult; }
    catch { continue; }
    if (legacy.document.parserSignature !== CURRENT_LEGACY_SIGNATURE) continue;
    const sha = name.replace(/-vlm-v1$/, '');
    const pdfFile = pdfs.get(sha);
    assert.ok(pdfFile, `no library PDF for ${sha}`);
    const names = (await fs.readdir(directory, { recursive: true })).filter(entry => !NOT_RAW.test(entry));
    const files = [];
    for (const entry of names) if ((await fs.stat(path.join(directory, entry))).isFile()) files.push(entry);
    const pdf = await openPdf(pdfFile);
    try {
      const { document } = await derive({
        sha, pdf,
        raw: { names: files, read: async entry => new Uint8Array(await fs.readFile(path.join(directory, entry))) },
        // Crops need a canvas; reuse the old reader's crops, which derive names identically.
        existingDerived: async asset => { try { return new Uint8Array(await fs.readFile(path.join(directory, asset))); } catch { return undefined; } },
        cropper: { cropPage: async (_page, requests) => new Map(requests.map(request => [request.blockId, { png: new Uint8Array(), width: 1, height: 1 }])) },
      });
      assert.equal(document.pageCount, legacy.document.pageCount);
      assert.deepEqual(document.blocks.map(comparable), legacy.document.blocks.map(comparable), `blocks differ for ${sha.slice(0, 12)}`);
      assert.deepEqual(document.warnings, legacy.document.warnings);
      compared++;
    } finally {
      await pdf.destroy();
    }
  }
  assert.ok(compared > 0, 'no old cache built by the current rule set was found');
});

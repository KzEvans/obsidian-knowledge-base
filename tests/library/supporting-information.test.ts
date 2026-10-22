import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createVaultFiles } from '../../src/library/files';
import { DEFAULT_SUPPORTING, candidateScore, collectLinks, isAuxiliaryPdfAttachment, isSupplementaryPdfAttachment, normalizeDoi, syncSupportingInformation, validatePublicUrl } from '../../src/library/zotero/supporting';
import type { SiClient } from '../../src/library/zotero/supporting';
import { tempDir, writeFile } from './helpers';

// Port of legacy tests/test_supporting_information.py plus the sync behaviour.

test('normalizes DOI URLs', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1021/ACS.BIOMAC.4C00431'), '10.1021/acs.biomac.4c00431');
  assert.equal(normalizeDoi('not a DOI'), '');
});

test('classifies Zotero SI without misclassifying the main PDF', () => {
  const supporting = { key: 'S', data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'bm4c00431_si_001.pdf', title: 'Supporting Information' } };
  const primary = { key: 'P', data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'paper.pdf', title: 'Full Text PDF' } };
  assert.equal(isSupplementaryPdfAttachment(supporting), true);
  assert.equal(isSupplementaryPdfAttachment(primary), false);
});

test('rejects a peer review PDF', () => {
  assert.ok(candidateScore('https://publisher.example/MOESM2_ESM.pdf', 'Transparent Peer Review file (download PDF)') < 0);
});

test('excludes a peer review attachment from primary papers', () => {
  const review = { key: 'R', data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'MOESM2_ESM.pdf', title: 'Transparent Peer Review file' } };
  assert.equal(isSupplementaryPdfAttachment(review), false);
  assert.equal(isAuxiliaryPdfAttachment(review), true);
});

test('accepts an explicit supplementary PDF', () => {
  assert.ok(candidateScore('https://publisher.example/MOESM1_ESM.pdf', 'Supplementary Information (download PDF)') >= 8);
});

test('local and private addresses are refused', () => {
  for (const url of ['http://localhost/x', 'http://127.0.0.1/x', 'http://10.0.0.2/x', 'http://192.168.1.1/x', 'file:///etc/passwd']) assert.throws(() => validatePublicUrl(url), url);
  validatePublicUrl('https://pubs.acs.org/doi/suppl/x.pdf');
});

test('link collection reads anchor text, title and nested markup', () => {
  const links = collectLinks('<html><a href="/a.pdf" title="Supporting">Download <b>SI</b> PDF</a><link rel="supplementary" href="/b.pdf"><a href="/c">x</a></html>');
  assert.deepEqual(links, [['/a.pdf', 'Supporting Download SI PDF'], ['/b.pdf', 'supplementary '], ['/c', 'x']]);
});

const pdf = (label: string) => new Uint8Array(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048, label)]));

test('SI sync copies Zotero SI, discovers publisher SI, and records a manifest; offline errors are kept apart', async () => {
  const root = await tempDir('pw-si-');
  const vault = path.join(root, 'vault');
  const zoteroSi = path.join(root, 'zotero', 'si.pdf');
  await writeFile(zoteroSi, pdf('z'));
  const files = createVaultFiles(vault);
  const requests: string[] = [];
  let offline = false;
  const client: SiClient = {
    async get(url) {
      requests.push(url);
      if (offline) throw new Error('getaddrinfo ENOTFOUND');
      if (url === 'https://pubs.example.org/doi/10.1234/b') return { bytes: new Uint8Array(), url, contentType: '', text: '<!doctype html><a href="/suppl/b_si_001.pdf">Supporting Information PDF</a>' };
      if (url === 'https://pubs.example.org/suppl/b_si_001.pdf') return { bytes: pdf('b'), url, contentType: '', text: '' };
      throw new Error(`unexpected ${url}`);
    },
    async postJson() { if (offline) throw new Error('getaddrinfo ENOTFOUND'); return { text: '[]' }; },
  };
  const parents = new Map([
    ['A', { key: 'A', data: { title: 'Paper A', DOI: '10.1234/a', url: 'https://pubs.example.org/none' } }],
    ['B', { key: 'B', data: { title: 'Paper B', DOI: '10.1234/b', url: 'https://pubs.example.org/doi/10.1234/b' } }],
  ]);
  // Paper A's landing page fails: an error, not "not found".
  const deps = { settings: DEFAULT_SUPPORTING, files, literatureDir: 'sources/literature', client, attachmentPath: async () => zoteroSi, log: () => undefined };
  const si = [{ key: 'ZSI', data: { itemType: 'attachment', contentType: 'application/pdf', parentItem: 'A', filename: 'a_si.pdf', title: 'Supporting Information' } }];
  const first = await syncSupportingInformation(parents, ['A', 'B'], si, deps);
  assert.equal(first.changed, true);
  const [a, b] = first.manifest.items;
  assert.equal(a!.status, 'available');
  assert.equal(a!.files[0]!.source, 'zotero');
  assert.equal(b!.status, 'available');
  assert.equal(b!.files[0]!.destination, 'sources/literature/si/B/b_si_001 (publisher-' + b!.files[0]!.destination.split('(publisher-')[1]);
  assert.ok((await fs.readFile(path.join(vault, b!.files[0]!.destination))).subarray(0, 5).equals(Buffer.from('%PDF-')));

  // Next hour: nothing is due, so no network and no rewrite.
  requests.length = 0;
  const second = await syncSupportingInformation(parents, ['A', 'B'], si, deps);
  assert.equal(requests.length, 0);
  assert.equal(second.changed, false);

  // A paper without SI, checked while offline, is a fetch_error retried tomorrow.
  offline = true;
  const third = await syncSupportingInformation(new Map([['C', { key: 'C', data: { title: 'C', DOI: '10.1234/c' } }]]), ['C'], [], deps);
  const c = third.manifest.items.find(entry => entry.parent_key === 'C')!;
  assert.equal(c.status, 'fetch_error');
  assert.ok(c.errors.some(error => error.includes('ENOTFOUND')));
  // Parents no longer in the library stay listed, inactive.
  assert.equal(third.manifest.items.find(entry => entry.parent_key === 'A')!.active, false);
});

test('a download that is not a PDF is refused', async () => {
  const root = await tempDir('pw-si-');
  const files = createVaultFiles(path.join(root, 'vault'));
  const client: SiClient = {
    async get(url) {
      if (url.endsWith('/landing')) return { bytes: new Uint8Array(), url, contentType: '', text: '<html><a href="/x_si.pdf">Supplementary Information</a></html>' };
      return { bytes: new TextEncoder().encode('<html>login</html>'.padEnd(2048)), url, contentType: '', text: '' };
    },
    async postJson() { return { text: '[]' }; },
  };
  const result = await syncSupportingInformation(new Map([['P', { key: 'P', data: { DOI: '10.1234/p', url: 'https://example.org/landing' } }]]), ['P'], [], { settings: DEFAULT_SUPPORTING, files, literatureDir: 'sources/literature', client, attachmentPath: async () => '', log: () => undefined });
  const entry = result.manifest.items[0]!;
  assert.equal(entry.files.length, 0);
  assert.ok(entry.errors.some(error => error.includes('not a valid PDF')));
});

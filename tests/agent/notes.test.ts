import { strict as assert } from 'node:assert';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { segmentHash } from '../../src/core/hash';
import type { StoreReader } from '../../src/core/store';
import type { Manifest, StoredBlock, StoredDocument, TranslationFile } from '../../src/core/types';
import type { AgentAdapter, AgentRequest } from '../../src/agent/cli/adapter';
import { composeNote } from '../../src/agent/notes/compose';
import { readList, readScalar, splitFrontmatter } from '../../src/agent/notes/frontmatter';
import { ABSTRACT_MARKER, abstractTranslation, fillAbstract } from '../../src/agent/notes/fulltext';
import { fullText } from '../../skills/paper-note/fulltext';
import { generateNote, snapshotOf, unchanged } from '../../src/agent/notes/generate';
import type { GenerateDeps, NoteFiles, NoteSnapshot } from '../../src/agent/notes/generate';
import { SUPPORTING_MANIFEST, ZOTERO_MANIFEST, collectionPath, noteIdentity, paperMetadata, plainTitle, safeStem } from '../../src/agent/notes/metadata';

const SHA = 'a'.repeat(64);
const PDF = 'sources/literature/pdf/软材料/驱动器/Smith 等 - 2024 - Soft (ABCD1234).pdf';

const block = (id: string, kind: StoredBlock['kind'], text: string, extra: Partial<StoredBlock> = {}): StoredBlock =>
  ({ id, kind, text, sources: [{ page: 1 }], translatable: true, ...extra });

const abstractText = 'We report a soft actuator.';
const document: StoredDocument = {
  schemaVersion: 2, sha256: SHA, normalizerVersion: 1, pageCount: 3, warnings: [], assets: {},
  blocks: [
    block('h0', 'header', 'Journal header p. 1'),
    block('t', 'heading', 'Soft actuators', { level: 1 }),
    block('a', 'paragraph', abstractText, { role: 'abstract', segments: [{ field: 'text', index: 0, sourceHash: segmentHash(abstractText) }] }),
    block('s', 'heading', 'Introduction', { level: 2 }),
    block('p', 'paragraph', 'Body text with $x^2$.'),
    block('f', 'figure', 'ocr junk', { captions: ['Figure 1. Device.'] }),
    block('e', 'equation', 'E = mc^2'),
    block('ft', 'footer', 'Page 3'),
  ],
};
const translations: TranslationFile = { schemaVersion: 1, failures: {}, entries: { [segmentHash(abstractText)]: { text: '我们报道了一种软驱动器。', model: 'qwen-mt-plus', termsKey: '', at: '' } } };

const manifest = (stage: Manifest['stage'] = 'ready'): Manifest => ({
  schemaVersion: 1, sha256: SHA, stage, failure: null, priority: false, updatedAt: '',
  sources: [{ path: PDF, zoteroAttachmentKey: 'ABCD1234', zoteroParentKey: 'PARENT01', inLibrary: true }],
});

const vaultFiles: Record<string, string> = {
  [ZOTERO_MANIFEST]: JSON.stringify({ schema_version: 1, items: [{
    active: true, attachment_key: 'ABCD1234', parent_key: 'PARENT01', sha256: SHA, creators: ['Jane Smith', 'Li Wei'],
    title: 'Soft actuators with CO<sub>2</sub> &amp; more', year: '2024', journal: 'Nature Materials', issn: '1476-1122', doi: '10.1/x',
    impact_factor: 38.5, impact_factor_year: '2025', impact_factor_source: 'https://example.org/if', impact_factor_retrieved_at: '2026-10-01T00:00:00+08:00',
  }] }),
  [SUPPORTING_MANIFEST]: JSON.stringify({ items: [{ parent_key: 'PARENT01', files: [{ destination: 'sources/literature/si/PARENT01/si.pdf' }] }] }),
  'system/knowledge/purpose.md': 'My research purpose.',
};
const readVaultText = (file: string) => Promise.resolve(vaultFiles[file] ?? null);

function store(stage: Manifest['stage'] = 'ready'): StoreReader {
  return {
    list: () => Promise.resolve([SHA]),
    shaForPath: () => Promise.resolve(SHA),
    manifest: () => Promise.resolve(manifest(stage)),
    document: () => Promise.resolve(document),
    translations: () => Promise.resolve(translations),
    readRaw: () => Promise.reject(new Error('unused')),
    readDerived: () => Promise.resolve(undefined),
    assetUrl: () => '',
    conflicts: () => Promise.resolve([]),
    paths: () => Promise.resolve({ [PDF]: SHA }),
  };
}

/** In-memory notes with the same publish contract as the vault implementation. */
function memoryFiles(initial: Record<string, string> = {}): NoteFiles & { notes: Map<string, { text: string; mtime: number }> } {
  const notes = new Map(Object.entries(initial).map(([key, text]) => [key, { text, mtime: 1000 }]));
  const snapshot = (notePath: string): NoteSnapshot | null => {
    const note = notes.get(notePath);
    return note ? snapshotOf(note.text, note.mtime) : null;
  };
  return {
    notes,
    snapshot: notePath => Promise.resolve(snapshot(notePath)),
    publish: (notePath, text, baseline) => {
      if (!unchanged(baseline, snapshot(notePath))) return Promise.resolve(false);
      notes.set(notePath, { text, mtime: (notes.get(notePath)?.mtime ?? 0) + 1 });
      return Promise.resolve(true);
    },
  };
}

const MODEL_NOTE = `---\nconcepts: ["[[软驱动器]]"]\nmaterials:\n  - "[[弹性体]]"\nmethods: []\nphenomena: ['[[大变形]]', '[[驱动]]']\ntitle: should be ignored\n---\n# Model title\n\n## 摘要翻译\n\n${ABSTRACT_MARKER}\n\n## 研究背景\n\n背景。\n\n# 提问\n\n模型编造的问答\n`;

function fakeAgent(onRun: (request: AgentRequest) => Promise<void> | void, note = MODEL_NOTE): { adapter: AgentAdapter; requests: AgentRequest[] } {
  const requests: AgentRequest[] = [];
  return {
    requests,
    adapter: {
      name: 'codex',
      async *run(request) {
        requests.push(request);
        await onRun(request);
        yield { type: 'done', text: JSON.stringify({ noteMarkdown: note }) };
      },
    },
  };
}

function deps(files: NoteFiles, agent: { adapter: AgentAdapter }, overrides: Partial<GenerateDeps> = {}): GenerateDeps & { saved: Map<string, string> } {
  const saved = new Map<string, string>();
  return {
    saved,
    store: store(), files, readVaultText,
    markdownPaths: () => ['wiki/concepts/软驱动器.md', 'wiki/papers/Other.md'],
    findExistingNote: () => undefined,
    agent: () => ({ adapter: agent.adapter, model: 'm1' }),
    vaultPath: '/vault', timeoutMs: 60_000, skill: 'SKILL TEXT',
    saveCandidate: (name, text) => { saved.set(name, text); return Promise.resolve(`/candidates/${name}`); },
    now: () => new Date(2026, 9, 21, 9, 30, 0),
    ...overrides,
  };
}

// ---- metadata and identity ----

test('metadata comes from the Zotero manifest; collection path from the library PDF path', async () => {
  const meta = await paperMetadata(manifest(), readVaultText);
  assert.equal(meta.title, 'Soft actuators with CO₂ & more');
  assert.deepEqual(meta.creators, ['Jane Smith', 'Li Wei']);
  assert.equal(meta.collectionPath, '软材料/驱动器');
  assert.equal(meta.impactFactor, 38.5);
  assert.deepEqual(meta.supportingInformation, ['sources/literature/si/PARENT01/si.pdf']);
  const identity = noteIdentity(meta, '2026-10-21');
  assert.equal(identity.displayTitle, '2026-10-21 - Jane Smith - Soft actuators with CO₂ & more');
  assert.equal(identity.notePath, 'wiki/papers/软材料/驱动器/2026-10-21 - Jane Smith - Soft actuators with CO₂ & more.md');
});

test('papers outside the library fall back to the file name and the papers root', async () => {
  const outside: Manifest = { ...manifest(), sources: [{ path: 'Inbox/Some Paper.pdf', inLibrary: false }] };
  const meta = await paperMetadata(outside, () => Promise.resolve(null));
  assert.equal(meta.title, 'Some Paper');
  assert.equal(noteIdentity(meta, '2026-10-21').notePath, 'wiki/papers/2026-10-21 - Unknown author - Some Paper.md');
});

test('collection path and file-name rules', () => {
  assert.equal(collectionPath('sources/literature/pdf/x.pdf'), '');
  assert.throws(() => collectionPath('sources/literature/pdf/images/x.pdf'));
  assert.equal(safeStem('a/b: c? [d]'), 'a_b_ c_ _d');
  assert.ok(Buffer.byteLength(safeStem('长'.repeat(200), 220)) <= 220);
  assert.equal(plainTitle('H<sup>+</sup> &lt;i&gt; <i>x</i>'), 'H⁺ <i> x');
});

// ---- full text and abstract ----

test('abstract translation fills the marker; without one the marker stays', () => {
  const translation = abstractTranslation(document, translations);
  assert.equal(translation, '我们报道了一种软驱动器。');
  assert.equal(fillAbstract(`## 摘要翻译\n\n${ABSTRACT_MARKER}\n`, translation), '## 摘要翻译\n\n我们报道了一种软驱动器。\n');
  assert.equal(abstractTranslation(document, undefined), undefined);
  assert.equal(fillAbstract('', undefined), `## 摘要翻译\n\n${ABSTRACT_MARKER}\n\n`);
  assert.ok(fillAbstract('', 'cost $1 and $& kept').includes('cost $1 and $& kept'));
});

// ---- compose ----

test('frontmatter: program fields, tag lists from the model, nothing from the removed features', async () => {
  const metadata = await paperMetadata(manifest(), readVaultText);
  const note = composeNote({ candidate: MODEL_NOTE, original: null, metadata, sha: SHA, displayTitle: 'D', generatedDate: '2026-10-21', generatedAt: '2026-10-21T09:30:00+08:00', abstract: '译文' });
  const fm = splitFrontmatter(note).frontmatter!;
  const expected: Record<string, string> = {
    type: 'paper', status: 'draft', reviewed: 'false', title: metadata.title, display_title: 'D', generated_date: '2026-10-21',
    zotero_item: 'PARENT01', zotero_attachment: 'ABCD1234', doi: '10.1/x', source_pdf: `[[${PDF}]]`, source_sha256: SHA,
    source_id: `paper:ABCD1234:${SHA.slice(0, 16)}`, year: '2024', journal: 'Nature Materials', issn: '1476-1122', impact_factor: '38.5',
    impact_factor_year: '2025', impact_factor_source: 'https://example.org/if', impact_factor_retrieved_at: '2026-10-01T00:00:00+08:00',
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(readScalar(fm, key), value, key);
  assert.deepEqual(readList(fm, 'supporting_information'), ['sources/literature/si/PARENT01/si.pdf']);
  assert.deepEqual(readList(fm, 'concepts'), ['[[软驱动器]]']);
  assert.deepEqual(readList(fm, 'materials'), ['[[弹性体]]']);
  assert.deepEqual(readList(fm, 'methods'), []);
  assert.deepEqual(readList(fm, 'phenomena'), ['[[大变形]]', '[[驱动]]']);
  for (const removed of ['extract', 'images_dir', 'supporting_information_used', 'generation_stage', 'paragraph_reading', 'reviewed_at', 'reviewed_content_sha256', 'integrated_at']) {
    assert.equal(readScalar(fm, removed), undefined, removed);
  }
  const body = splitFrontmatter(note).body;
  assert.ok(body.startsWith('\n# D\n\n## 摘要翻译\n\n译文\n'));
  assert.ok(!body.includes('Model title'));
});

// ---- the whole generation ----

test('generation: workspace contents, agent request, publish, lint', async () => {
  const files = memoryFiles();
  const agent = fakeAgent(async request => {
    const names = (await fs.readdir(request.cwd)).sort();
    assert.deepEqual(names, ['fulltext.md', 'metadata.json', 'purpose.md', 'vault-titles.md']);
    assert.equal(await fs.readFile(path.join(request.cwd, 'fulltext.md'), 'utf8'), fullText(document));
    assert.ok((await fs.readFile(path.join(request.cwd, 'vault-titles.md'), 'utf8')).includes('- wiki/concepts/软驱动器'));
  });
  const result = await generateNote(SHA, deps(files, agent), new AbortController().signal);
  assert.equal(result.conflict, false);
  assert.equal(result.abstractFilled, true);
  assert.deepEqual(Object.keys(result.lint).sort(), ['length', 'ok', 'problems']);
  const request = agent.requests[0]!;
  assert.equal(request.mode, 'read-only');
  assert.ok(request.instructions?.startsWith('SKILL TEXT'));
  assert.deepEqual(request.readableDirs, ['/vault']);
  assert.equal(request.model, 'm1');
  assert.ok(!existsSync(request.cwd), 'workspace removed');
  const notePath = 'wiki/papers/软材料/驱动器/2026-10-21 - Jane Smith - Soft actuators with CO₂ & more.md';
  const written = files.notes.get(notePath)?.text ?? '';
  assert.ok(written.includes('我们报道了一种软驱动器。'));
  assert.ok(!written.includes('模型编造的问答'));
});

test('generation refuses papers that are not ready', async () => {
  const agent = fakeAgent(() => undefined);
  await assert.rejects(generateNote(SHA, deps(memoryFiles(), agent, { store: store('translating') }), new AbortController().signal), /还没有处理完成/);
  assert.equal(agent.requests.length, 0);
});

test('regeneration keeps the note path, the human blocks and the generated date', async () => {
  const notePath = 'wiki/papers/旧目录/2026-09-01 - Jane Smith - Soft.md';
  const original = '---\ntype: paper\nstatus: "reviewed"\nreviewed: true\nextract: "[[x]]"\n---\n# 2026-09-01 - Jane Smith - Soft\n\n旧正文\n\n## 人工复核\n- [x] 已核对\n\n<!-- user-notes:start -->\n我的想法\n<!-- user-notes:end -->\n\n# 提问\n\n## 1\n\nQ：旧问题\n\nA：旧回答\n';
  const files = memoryFiles({ [notePath]: original });
  const result = await generateNote(SHA, deps(files, fakeAgent(() => undefined), { findExistingNote: () => notePath }), new AbortController().signal);
  assert.equal(result.notePath, notePath);
  const written = files.notes.get(notePath)!.text;
  for (const kept of ['- [x] 已核对', '我的想法', 'Q：旧问题', 'A：旧回答']) assert.ok(written.includes(kept), kept);
  assert.ok(!written.includes('旧正文') && !written.includes('extract:'));
  const fm = splitFrontmatter(written).frontmatter!;
  assert.equal(readScalar(fm, 'generated_date'), '2026-09-01');
  assert.equal(readScalar(fm, 'status'), 'draft');
  assert.ok(written.includes('\n# 2026-09-01 - Jane Smith - Soft\n'));
});

test('a note edited during generation is not overwritten; the candidate is kept', async () => {
  const notePath = 'wiki/papers/x.md';
  const files = memoryFiles({ [notePath]: '---\ntype: paper\n---\n# x\n原稿\n' });
  const agent = fakeAgent(() => { files.notes.set(notePath, { text: '---\ntype: paper\n---\n# x\n你在生成期间的修改\n', mtime: 2000 }); });
  const run = deps(files, agent, { findExistingNote: () => notePath });
  const result = await generateNote(SHA, run, new AbortController().signal);
  assert.equal(result.conflict, true);
  assert.equal(files.notes.get(notePath)!.text, '---\ntype: paper\n---\n# x\n你在生成期间的修改\n');
  assert.ok(result.candidatePath?.startsWith('/candidates/'));
  assert.ok([...run.saved.values()][0]!.includes('## 研究背景'));
});

test('touching the note without changing it (mtime only) also counts as a conflict; a new note created meanwhile too', async () => {
  const notePath = 'wiki/papers/x.md';
  const text = '---\ntype: paper\n---\n# x\n';
  const files = memoryFiles({ [notePath]: text });
  const touched = await generateNote(SHA, deps(files, fakeAgent(() => { files.notes.set(notePath, { text, mtime: 5000 }); }), { findExistingNote: () => notePath }), new AbortController().signal);
  assert.equal(touched.conflict, true);
  const fresh = memoryFiles();
  const created = await generateNote(SHA, deps(fresh, fakeAgent(() => {
    fresh.notes.set('wiki/papers/软材料/驱动器/2026-10-21 - Jane Smith - Soft actuators with CO₂ & more.md', { text: 'someone else', mtime: 1 });
  })), new AbortController().signal);
  assert.equal(created.conflict, true);
});

test('missing note.md is an error', async () => {
  const adapter: AgentAdapter = { name: 'claude', async *run() { yield { type: 'done', text: '' }; } };
  await assert.rejects(generateNote(SHA, deps(memoryFiles(), { adapter }), new AbortController().signal), /note\.md/);
});

test('an invented # 提问 is dropped even when the old note had no protected blocks', async () => {
  const notePath = 'wiki/papers/plain.md';
  const files = memoryFiles({ [notePath]: '---\ntype: paper\n---\n# plain\n正文\n' });
  await generateNote(SHA, deps(files, fakeAgent(() => undefined), { findExistingNote: () => notePath }), new AbortController().signal);
  assert.ok(!files.notes.get(notePath)!.text.includes('模型编造的问答'));
});

test('a new-paper filename collision preserves the unrelated note and saves a candidate', async () => {
  const notePath = 'wiki/papers/软材料/驱动器/2026-10-21 - Jane Smith - Soft actuators with CO₂ & more.md';
  const original = `---\ntype: paper\nsource_sha256: ${'b'.repeat(64)}\n---\n# Another paper\nHuman text\n`;
  const files = memoryFiles({ [notePath]: original });
  const run = deps(files, fakeAgent(() => undefined));
  const result = await generateNote(SHA, run, new AbortController().signal);
  assert.equal(result.conflict, true);
  assert.equal(files.notes.get(notePath)?.text, original);
  assert.equal(run.saved.size, 1);
});

test('cancellation after CLI completion or at the publish boundary prevents publishing', async () => {
  for (const phase of ['result', 'publish']) {
    const controller = new AbortController();
    const files = memoryFiles();
    const agent = fakeAgent(() => { if (phase === 'result') controller.abort(); });
    await assert.rejects(generateNote(SHA, deps(files, agent), controller.signal, status => {
      if (phase === 'publish' && status === '正在发布…') controller.abort();
    }), { name: 'AbortError' });
    assert.equal(files.notes.size, 0);
  }
});

test('the program replaces the whole abstract section even if the model omits or misplaces its marker', () => {
  for (const body of [
    '## 摘要翻译\n\nModel paraphrase\n\n## 研究背景\n\nBackground\n',
    `## 摘要翻译\n\nModel paraphrase\n\n## 研究背景\n\n${ABSTRACT_MARKER}\n`,
    '## 研究背景\n\nBackground\n',
  ]) {
    const filled = fillAbstract(body, 'Qwen exact text $&');
    assert.match(filled, /^## 摘要翻译\n\nQwen exact text \$&\n\n## 研究背景/);
    assert.ok(!filled.includes('Model paraphrase'));
  }
});

test('partial abstract translations stay incomplete instead of silently dropping a paragraph', () => {
  const extra = block('a2', 'paragraph', 'Second abstract paragraph.', { role: 'abstract', segments: [{ field: 'text', index: 0, sourceHash: 'missing' }] });
  assert.equal(abstractTranslation({ ...document, blocks: [...document.blocks, extra] }, translations), undefined);
});

test('generation uses read-only structured output and writes note.md itself', async () => {
  const adapter: AgentAdapter = {
    name: 'codex',
    async *run(request) {
      assert.equal(request.mode, 'read-only');
      assert.ok(request.outputSchema);
      yield { type: 'done', text: JSON.stringify({ noteMarkdown: MODEL_NOTE }) };
    },
  };
  const files = memoryFiles();
  await generateNote(SHA, deps(files, { adapter }), new AbortController().signal);
  assert.equal(files.notes.size, 1);
});

test('candidate tags accept standard YAML quoting, commas and comments', () => {
  assert.deepEqual(readList("concepts: ['[[A, B]]', '[[C]]'] # comment", 'concepts'), ['[[A, B]]', '[[C]]']);
  assert.deepEqual(readList('concepts:\n  - "[[A, B]]" # comment\n', 'concepts'), ['[[A, B]]']);
});

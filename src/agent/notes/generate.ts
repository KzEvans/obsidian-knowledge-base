import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Text } from '../../core/hash';
import type { StoreReader } from '../../core/store';
import { fullText } from '../../../skills/paper-note/fulltext';
import { NOTE_OUTPUT_SCHEMA, noteMarkdown } from '../../../skills/paper-note/output';
import { lintNote } from '../../../skills/paper-note/lint';
import type { LintResult } from '../../../skills/paper-note/lint';
import { collect } from '../cli/adapter';
import type { AgentAdapter } from '../cli/adapter';
import { composeNote } from './compose';
import { abstractTranslation } from './fulltext';
import { PURPOSE_PATH, localDate, localIso, noteIdentity, paperMetadata } from './metadata';
import type { PaperMetadata } from './metadata';

export interface NoteSnapshot { text: string; mtime: number; hash: string }

export function snapshotOf(text: string, mtime: number): NoteSnapshot {
  return { text, mtime, hash: sha256Text(text) };
}

/** Both mtime and content must match the snapshot taken before generation. */
export function unchanged(baseline: NoteSnapshot | null, current: NoteSnapshot | null): boolean {
  if (!baseline || !current) return baseline === current;
  return baseline.mtime === current.mtime && baseline.hash === current.hash;
}

export interface NoteFiles {
  snapshot(notePath: string): Promise<NoteSnapshot | null>;
  /** Writes only while the note still matches `baseline` (null: must not exist yet). False means conflict. */
  publish(notePath: string, text: string, baseline: NoteSnapshot | null, signal: AbortSignal): Promise<boolean>;
}

export interface GenerateDeps {
  store: StoreReader;
  files: NoteFiles;
  readVaultText(vaultPath: string): Promise<string | null>;
  /** Markdown paths in the vault, for the title list the agent links against. */
  markdownPaths(): string[];
  /** An existing note for this paper (by source_sha256 or zotero_attachment). */
  findExistingNote(sha: string, attachmentKey: string): string | undefined;
  agent(): { adapter: AgentAdapter; model?: string };
  vaultPath: string;
  timeoutMs: number;
  skill: string;
  /** Keep a candidate that could not be published; returns where it went. */
  saveCandidate(fileName: string, text: string): Promise<string>;
  now(): Date;
}

export interface GenerateResult {
  notePath: string;
  conflict: boolean;
  candidatePath?: string;
  lint: LintResult;
  abstractFilled: boolean;
}

export class GenerationError extends Error {}

export async function generateNote(sha: string, deps: GenerateDeps, signal: AbortSignal, onStatus: (message: string) => void = () => undefined): Promise<GenerateResult> {
  signal.throwIfAborted();
  const manifest = await deps.store.manifest(sha);
  if (manifest?.stage !== 'ready') throw new GenerationError('这篇论文还没有处理完成（需要解析和翻译都就绪）。');
  const document = await deps.store.document(sha);
  if (!document) throw new GenerationError('解析存储中没有这篇论文的规范化全文。');
  const translations = await deps.store.translations(sha);
  const metadata = await paperMetadata(manifest, vaultPath => deps.readVaultText(vaultPath));

  const existing = deps.findExistingNote(sha, metadata.zoteroAttachment);
  const now = deps.now();
  let generatedDate = localDate(now);
  let notePath: string;
  let displayTitle: string;
  if (existing) {
    // Regenerating keeps the note where it is (library moves it with its collection).
    notePath = existing;
    displayTitle = path.posix.basename(existing, '.md');
    generatedDate = /^(\d{4}-\d{2}-\d{2}) - /.exec(displayTitle)?.[1] ?? generatedDate;
  } else {
    ({ notePath, displayTitle } = noteIdentity(metadata, generatedDate));
  }
  const baseline = existing ? await deps.files.snapshot(notePath) : null;
  signal.throwIfAborted();

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-workbench-note-'));
  try {
    onStatus('正在准备工作区…');
    await writeWorkspace(workspace, { document: fullText(document), metadata, purpose: await deps.readVaultText(PURPOSE_PATH), titles: deps.markdownPaths() });
    const { adapter, model } = deps.agent();
    onStatus(`${adapter.name === 'codex' ? 'Codex' : 'Claude Code'} 正在撰写笔记…`);
    signal.throwIfAborted();
    const result = await collect(adapter.run({
      prompt: generationPrompt(deps.vaultPath),
      instructions: deps.skill + '\n本次通过只读结构化输出交付：将完整笔记 Markdown 放入 noteMarkdown 字符串，由程序保存为 note.md；不要调用写入工具。',
      cwd: workspace,
      readableDirs: [deps.vaultPath],
      model,
      timeoutMs: deps.timeoutMs,
      mode: 'read-only',
      outputSchema: NOTE_OUTPUT_SCHEMA,
      ephemeral: true,
    }, signal));
    signal.throwIfAborted();
    const candidate = noteMarkdown(result.text);
    await fs.writeFile(path.join(workspace, 'note.md'), candidate);
    signal.throwIfAborted();

    const abstract = abstractTranslation(document, translations);
    const note = composeNote({
      candidate, original: baseline?.text ?? null, metadata, sha, displayTitle, generatedDate, generatedAt: localIso(now), abstract,
    });
    const lint = lintNote(note);
    onStatus('正在发布…');
    signal.throwIfAborted();
    if (await deps.files.publish(notePath, note, baseline, signal)) {
      return { notePath, conflict: false, lint, abstractFilled: abstract !== undefined };
    }
    signal.throwIfAborted();
    const candidatePath = await deps.saveCandidate(`${localIso(now).replace(/[:+]/g, '-')} ${path.posix.basename(notePath)}`, note);
    return { notePath, conflict: true, candidatePath, lint, abstractFilled: abstract !== undefined };
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

async function writeWorkspace(dir: string, input: { document: string; metadata: PaperMetadata; purpose: string | null; titles: string[] }): Promise<void> {
  const meta = input.metadata;
  await fs.writeFile(path.join(dir, 'fulltext.md'), input.document);
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({
    title: meta.title, authors: meta.creators, year: meta.year, journal: meta.journal, doi: meta.doi, url: meta.url,
    impact_factor: meta.impactFactor, source_pdf: meta.sourcePdf, collection: meta.collectionPath,
    supporting_information: meta.supportingInformation,
  }, null, 2) + '\n');
  if (input.purpose?.trim()) await fs.writeFile(path.join(dir, 'purpose.md'), input.purpose);
  await fs.writeFile(path.join(dir, 'vault-titles.md'), input.titles.map(title => `- ${title.replace(/\.md$/, '')}`).join('\n') + '\n');
}

/** Only the workspace; how to write the note is PAPER_NOTE_SKILL's job (passed as instructions). */
export function generationPrompt(vaultPath: string): string {
  return [
    '按 paper-note 规范撰写完整笔记，以 JSON 对象的 noteMarkdown 字符串返回，程序将其保存为 note.md。',
    '',
    '工作目录中的文件：',
    '- fulltext.md：论文规范化全文。',
    '- metadata.json：题录信息。',
    '- purpose.md（可能不存在）：研究目标。',
    '- vault-titles.md：知识库中已有笔记和概念页的路径清单。',
    `知识库目录（只读）：${vaultPath}`,
    '所有输入只读，不要创建、修改或删除文件。',
  ].join('\n');
}

/**
 * Generate notes for the evaluation papers with Codex and Claude, then lint them.
 * Reads only local files; writes only under the output directory (outside the repo).
 *
 *   PAPER_WORKBENCH_VAULT="<vault>" PAPER_NOTE_EVAL_CACHE="<cache>" pnpm exec tsx --import ./tests/setup.ts skills/paper-note/eval/run.ts --round r1
 *
 * Options: --round <name> (required), --adapters codex,claude, --papers <attachment keys>,
 * --inputs-only (build the inputs and stop). PAPER_NOTE_EVAL_OUT overrides the output
 * directory (default ~/Developer/paper-workbench-eval). See ../README.md.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PAPER_NOTE_SKILL } from '../index';
import { lintNote } from '../lint';
import { fullText } from '../fulltext';
import { deriveFromCache } from './fulltext';
import { EVAL_PAPERS, readFrontmatter, type ZoteroItem } from './papers';

const say = (text: string) => process.stdout.write(text + '\n');

const vault = process.env.PAPER_WORKBENCH_VAULT;
if (!vault) throw new Error('请设置 PAPER_WORKBENCH_VAULT。');
/** The old reader's MinerU cache: <vault>/<config dir>/plugins/pdf-reading-mode/cache. */
const cacheRoot = process.env.PAPER_NOTE_EVAL_CACHE ?? '';
if (!cacheRoot) throw new Error('请设置 PAPER_NOTE_EVAL_CACHE（旧阅读插件的 MinerU 缓存目录）。');
const out = process.env.PAPER_NOTE_EVAL_OUT ?? path.join(os.homedir(), 'Developer/paper-workbench-eval');
const TIMEOUT_MS = 30 * 60_000;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const round = option('round');
if (!round && !process.argv.includes('--inputs-only')) throw new Error('请用 --round <名称> 指定本轮评测。');
const adapters = (option('adapters') ?? 'codex,claude').split(',') as Adapter[];
const keys = option('papers')?.split(',') ?? EVAL_PAPERS.map(paper => paper.key);

type Adapter = 'codex' | 'claude';

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

/** Old notes in wiki/, keyed by vault-relative path, with their frontmatter. */
async function wikiNotes(): Promise<Array<{ relative: string; attachment?: string; sha?: string }>> {
  const notes = [];
  for (const entry of await fs.readdir(path.join(vault!, 'wiki'), { recursive: true })) {
    if (!entry.endsWith('.md') || entry.split(path.sep).includes('images')) continue;
    const relative = path.join('wiki', entry);
    const frontmatter = readFrontmatter(await fs.readFile(path.join(vault!, relative), 'utf8'));
    notes.push({ relative, ...(frontmatter.zotero_attachment ? { attachment: frontmatter.zotero_attachment } : {}), ...(frontmatter.source_sha256 ? { sha: frontmatter.source_sha256 } : {}) });
  }
  return notes;
}

/** paper.md, metadata.json, purpose.md for one paper, built once and reused across rounds. */
async function buildInputs(item: ZoteroItem): Promise<string> {
  const directory = path.join(out, 'inputs', item.attachment_key);
  await fs.mkdir(directory, { recursive: true });
  const paper = path.join(directory, 'paper.md');
  if (!await exists(paper)) {
    const cache = path.join(cacheRoot, `${item.sha256}-vlm-v1`);
    const document = await deriveFromCache(cache, path.join(vault!, item.destination), item.sha256);
    await fs.writeFile(paper, fullText(document));
  }
  const metadata = {
    title: item.title, authors: item.creators, year: item.year, journal: item.journal, doi: item.doi,
  };
  await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  const purpose = path.join(vault!, 'system/knowledge/purpose.md');
  if (await exists(purpose)) await fs.copyFile(purpose, path.join(directory, 'purpose.md'));
  return directory;
}

/** A workspace with the inputs and a read-only-in-spirit copy of wiki/ minus this paper's old note. */
async function buildWorkspace(item: ZoteroItem, inputs: string, adapter: Adapter, notes: Awaited<ReturnType<typeof wikiNotes>>): Promise<string> {
  const work = path.join(out, 'runs', round!, item.attachment_key, adapter, 'work');
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });
  for (const name of await fs.readdir(inputs)) await fs.copyFile(path.join(inputs, name), path.join(work, name));
  const kept = notes.filter(note => note.attachment !== item.attachment_key && note.sha !== item.sha256);
  for (const note of kept) {
    const target = path.join(work, 'vault', note.relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(vault!, note.relative), target);
  }
  const titles = kept.map(note => `- ${path.basename(note.relative, '.md')}（vault/${note.relative}）`).sort();
  await fs.writeFile(path.join(work, 'vault-titles.md'), `# vault 中的笔记和概念页\n\n${titles.join('\n')}\n`);
  return work;
}

const TASK = `
---

# 本次任务

为当前目录中的论文写笔记，写入当前目录的 note.md。

- 规范化全文：paper.md
- 元数据：metadata.json
- 研究方向：purpose.md（若不存在则按“文件不存在”处理）
- vault 标题清单：vault-titles.md；vault 的只读副本在 vault/ 目录，可以搜索

只写 note.md，不修改其他文件。写完后不需要在回复里复述笔记内容。
`;

function run(command: string, args: string[], cwd: string, input: string, log: string): Promise<{ code: number | null; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    void fs.open(log, 'w').then(handle => {
      const child = spawn(command, args, { cwd, stdio: ['pipe', handle.fd, handle.fd], detached: true });
      const timer = window.setTimeout(() => { if (child.pid) process.kill(-child.pid, 'SIGTERM'); }, TIMEOUT_MS);
      child.on('error', reject);
      child.on('close', code => { window.clearTimeout(timer); void handle.close(); resolve({ code, ms: Date.now() - started }); });
      child.stdin?.end(input);
    }, reject);
  });
}

function adapterCommand(adapter: Adapter, work: string): [string, string[]] {
  if (adapter === 'codex') {
    return ['codex', ['exec', '-C', work, '-s', 'workspace-write', '--skip-git-repo-check', '--ephemeral', '--json', '-o', path.join(work, '..', 'last-message.txt'), '-']];
  }
  return ['claude', ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--tools', 'Read,Grep,Glob,Write,Edit',
    '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence']];
}

async function generate(item: ZoteroItem, adapter: Adapter, notes: Awaited<ReturnType<typeof wikiNotes>>) {
  const inputs = await buildInputs(item);
  const work = await buildWorkspace(item, inputs, adapter, notes);
  const runDirectory = path.dirname(work);
  const [command, args] = adapterCommand(adapter, work);
  const { code, ms } = await run(command, args, work, PAPER_NOTE_SKILL + TASK, path.join(runDirectory, 'cli.log'));
  const notePath = path.join(work, 'note.md');
  const note = await exists(notePath) ? await fs.readFile(notePath, 'utf8') : '';
  await fs.writeFile(path.join(runDirectory, 'note.md'), note);
  const lint = lintNote(note);
  const result = { paper: item.attachment_key, adapter, exitCode: code, minutes: +(ms / 60_000).toFixed(1), length: lint.length, ok: lint.ok, problems: lint.problems };
  await fs.writeFile(path.join(runDirectory, 'lint.json'), JSON.stringify(result, null, 2) + '\n');
  say(`${item.attachment_key} ${adapter}: 退出码 ${code}，${result.minutes} 分钟，${lint.length} 字，${lint.problems.length} 个问题`);
  return result;
}

const manifest = JSON.parse(await fs.readFile(path.join(vault, 'sources/literature/manifests/zotero-doc.json'), 'utf8')) as { items: ZoteroItem[] };
const items = keys.map(key => {
  const item = manifest.items.find(candidate => candidate.attachment_key === key);
  if (!item) throw new Error(`manifest 中没有附件 ${key}`);
  return item;
});

if (process.argv.includes('--inputs-only')) {
  for (const item of items) say(await buildInputs(item));
} else {
  const notes = await wikiNotes();
  // Inputs first (derive is slow on iCloud files), then all CLI runs in parallel.
  for (const item of items) await buildInputs(item);
  const results = await Promise.all(items.flatMap(item => adapters.map(adapter => generate(item, adapter, notes))));
  const summary = path.join(out, 'runs', round!, 'summary.json');
  await fs.writeFile(summary, JSON.stringify(results, null, 2) + '\n');
  say(`汇总：${summary}`);
}

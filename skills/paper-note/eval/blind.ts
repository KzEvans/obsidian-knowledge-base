/**
 * Blind-review material: each new note beside the vault's old note for the same paper,
 * randomly labelled A/B. The answer key is written to a separate file.
 *
 *   PAPER_WORKBENCH_VAULT="<vault>" pnpm exec tsx --import ./tests/setup.ts skills/paper-note/eval/blind.ts --round r1
 *
 * Output (under PAPER_NOTE_EVAL_OUT, default ~/Developer/paper-workbench-eval):
 *   blind/<round>/P<n>/{A.md,B.md,compare.html}, blind/<round>/answers.json
 */
import { randomInt } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EVAL_PAPERS, readFrontmatter } from './papers';

const vault = process.env.PAPER_WORKBENCH_VAULT;
if (!vault) throw new Error('请设置 PAPER_WORKBENCH_VAULT。');
const out = process.env.PAPER_NOTE_EVAL_OUT ?? path.join(os.homedir(), 'Developer/paper-workbench-eval');
const roundIndex = process.argv.indexOf('--round');
const round = roundIndex >= 0 ? process.argv[roundIndex + 1] : undefined;
if (!round) throw new Error('请用 --round <名称> 指定要盲评的那一轮。');
const ADAPTERS = ['codex', 'claude'] as const;
const PROTECTED = /^(#{1,6})\s+(人工复核|Human Review|提问)\s*$/;

/** Old note without frontmatter, title, user-owned sections, or image embeds that cannot render here. */
function cleanOld(markdown: string): string {
  const lines = markdown.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const kept: string[] = [];
  let skipLevel = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading && skipLevel && heading[1]!.length <= skipLevel) skipLevel = 0;
    const protectedHeading = PROTECTED.exec(line);
    if (protectedHeading) skipLevel = protectedHeading[1]!.length;
    if (skipLevel || /^#\s/.test(line)) continue;
    kept.push(line.replace(/!\[\[[^\]]*\]\]/g, '[图片]'));
  }
  return kept.join('\n').trim() + '\n';
}

const cleanNew = (markdown: string) => markdown.replace(/^---\n[\s\S]*?\n---\n/, '').replace('<!-- abstract-translation -->', '（摘要译文由程序填入，盲评材料中省略。）').trim() + '\n';

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const compareHtml = (a: string, b: string) => `<!doctype html><meta charset="utf-8"><title>盲评</title>
<style>body{margin:0;font:15px/1.7 -apple-system,"PingFang SC",sans-serif}main{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px}
section{min-width:0}h1{font-size:18px;position:sticky;top:0;background:#fff;margin:0;padding:8px 0}pre{white-space:pre-wrap;word-break:break-word;font:inherit}</style>
<main><section><h1>A</h1><pre>${escapeHtml(a)}</pre></section><section><h1>B</h1><pre>${escapeHtml(b)}</pre></section></main>\n`;

const oldNotes = new Map<string, string>();
const papersDirectory = path.join(vault, 'wiki/papers');
for (const entry of await fs.readdir(papersDirectory, { recursive: true })) {
  if (!entry.endsWith('.md')) continue;
  const text = await fs.readFile(path.join(papersDirectory, entry), 'utf8');
  const key = readFrontmatter(text).zotero_attachment;
  if (key) oldNotes.set(key, text);
}

const pairs: Array<{ paper: string; adapter: string; newNote: string; oldNote: string }> = [];
for (const paper of EVAL_PAPERS) {
  const oldNote = oldNotes.get(paper.key);
  if (!oldNote) continue;
  for (const adapter of ADAPTERS) {
    const file = path.join(out, 'runs', round, paper.key, adapter, 'note.md');
    let newNote: string;
    try { newNote = await fs.readFile(file, 'utf8'); } catch { continue; }
    if (newNote.trim()) pairs.push({ paper: paper.label, adapter, newNote: cleanNew(newNote), oldNote: cleanOld(oldNote) });
  }
}
// Shuffle so pair numbers reveal neither paper order nor adapter.
for (let index = pairs.length - 1; index > 0; index--) {
  const other = randomInt(index + 1);
  [pairs[index], pairs[other]] = [pairs[other]!, pairs[index]!];
}

const directory = path.join(out, 'blind', round);
await fs.rm(directory, { recursive: true, force: true });
const answers: Record<string, { paper: string; A: string; B: string }> = {};
for (const [index, pair] of pairs.entries()) {
  const id = `P${index + 1}`;
  const newIsA = randomInt(2) === 0;
  const [a, b] = newIsA ? [pair.newNote, pair.oldNote] : [pair.oldNote, pair.newNote];
  const pairDirectory = path.join(directory, id);
  await fs.mkdir(pairDirectory, { recursive: true });
  await fs.writeFile(path.join(pairDirectory, 'A.md'), a);
  await fs.writeFile(path.join(pairDirectory, 'B.md'), b);
  await fs.writeFile(path.join(pairDirectory, 'compare.html'), compareHtml(a, b));
  const label = `新笔记（${pair.adapter}）`;
  answers[id] = { paper: pair.paper, A: newIsA ? label : '旧笔记', B: newIsA ? '旧笔记' : label };
}
await fs.writeFile(path.join(directory, 'answers.json'), JSON.stringify(answers, null, 2) + '\n');
process.stdout.write(`${pairs.length} 组盲评材料：${directory}（答案在 answers.json，先不要打开）\n`);

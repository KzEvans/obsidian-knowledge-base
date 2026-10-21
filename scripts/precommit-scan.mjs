#!/usr/bin/env node
// Refuse commits that would publish papers, credentials or local vault paths.
// Usage: node scripts/precommit-scan.mjs [--staged]
// A line containing `scan:allow` is skipped (for deliberate fake fixtures).
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const staged = process.argv.includes('--staged');
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const files = (staged
  ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
  : git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
).split('\0').filter(Boolean);

const read = file => staged ? execFileSync('git', ['show', `:${file}`], { maxBuffer: 64 * 1024 * 1024 }) : readFileSync(file);

const CONTENT_RULES = [
  ['密钥（sk- 形式）', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['Bearer 凭据', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/],
  ['私钥', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['iCloud vault 路径', /Mobile Documents\/iCloud~md~obsidian/],
  ['本机用户目录', /\/Users\/[A-Za-z0-9._-]+\//],
  ['带签名的下载地址', /[?&](?:X-Amz-Signature|OSSAccessKeyId|Signature)=/],
];
const MAX_BYTES = 5 * 1024 * 1024;

const problems = [];
for (const file of files) {
  if (!staged) { try { if (!statSync(file).isFile()) continue; } catch { continue; } }
  if (/\.pdf$/i.test(file) && !file.startsWith('tests/fixtures/')) { problems.push(`${file}: PDF 文件不能提交`); continue; }
  const bytes = read(file);
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-' && !file.startsWith('tests/fixtures/')) { problems.push(`${file}: PDF 内容不能提交`); continue; }
  if (bytes.length > MAX_BYTES) { problems.push(`${file}: 文件超过 5 MB`); continue; }
  if (bytes.includes(0)) continue; // binary
  const lines = bytes.toString('utf8').split('\n');
  lines.forEach((line, index) => {
    if (line.includes('scan:allow')) return;
    for (const [label, pattern] of CONTENT_RULES) {
      if (pattern.test(line)) problems.push(`${file}:${index + 1}: ${label}`);
    }
  });
}

if (problems.length) {
  console.error('提交前扫描发现问题：\n' + problems.map(problem => '  ' + problem).join('\n'));
  process.exit(1);
}
console.log(`提交前扫描通过（${files.length} 个文件）。`);

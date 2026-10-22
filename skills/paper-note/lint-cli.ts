/**
 * Lint notes from the command line:
 *   pnpm exec tsx skills/paper-note/lint-cli.ts <note.md> [...]
 * Prints one line per problem; exits 1 when any note has problems. `--json` prints the results.
 */
import { readFileSync } from 'node:fs';

// lint.ts imports Markdown as text; the test loader registers that hook, so load it first.
await import('../../tests/setup');
const { lintNote } = await import('./lint');

const say = (text: string) => process.stdout.write(text + '\n');

const args = process.argv.slice(2);
const json = args.includes('--json');
const files = args.filter(arg => arg !== '--json');
if (!files.length) {
  process.stderr.write('用法：pnpm exec tsx skills/paper-note/lint-cli.ts [--json] <note.md> [...]\n');
  process.exit(2);
}

let failed = false;
const results = files.map(file => ({ file, ...lintNote(readFileSync(file, 'utf8')) }));
for (const result of results) {
  failed ||= !result.ok;
  if (json) continue;
  say(`${result.file}: ${result.ok ? '通过' : `${result.problems.length} 个问题`}，正文 ${result.length} 字`);
  for (const problem of result.problems) {
    const where = [problem.line && `第 ${problem.line} 行`, problem.section && `「${problem.section}」`].filter(Boolean).join(' ');
    say(`  [${problem.rule}]${where ? ` ${where}` : ''} ${problem.message}`);
  }
}
if (json) say(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);

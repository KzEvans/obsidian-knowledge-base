import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAnnotations, quoteMatches, quoteText, writeAnnotation } from '../../src/reader/annotations/note';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);
const ORDER: Record<string, number> = { [H1.slice(0, 12)]: 1, [H2.slice(0, 12)]: 2, [H3.slice(0, 12)]: 3 };
const order = (id: string) => ORDER[id];
const entry = (anchor: string, body: string, page = 3) => ({ anchor, link: `[[p.pdf#page=${page}|p.${page}]]`, text: `Paragraph ${anchor[0]} text.`, body });

const GENERATED = '---\ntype: paper\n---\n\n# Title\n\n## 摘要翻译\n\n摘要\n\n## 与现有知识的候选关联\n\n关联\n\n## 我的理解\n';

test('the first annotation creates the section after 我的理解 and reads back', () => {
  const note = writeAnnotation(GENERATED, entry(H2, '我的想法\n\n第二段'), order);
  assert.equal(note, `${GENERATED}\n## 段落批注\n\n> [!quote] [[p.pdf#page=3|p.3]] %%pw:${H2.slice(0, 12)}%%\n> Paragraph b text.\n\n我的想法\n\n第二段\n`);
  assert.deepEqual(parseAnnotations(note), [{ id: H2.slice(0, 12), quote: 'Paragraph b text.', body: '我的想法\n\n第二段' }]);
});

test('entries stay in paper order, whatever order they were written in', () => {
  let note = writeAnnotation(GENERATED, entry(H2, 'two'), order);
  note = writeAnnotation(note, entry(H3, 'three'), order);
  note = writeAnnotation(note, entry(H1, 'one'), order);
  assert.deepEqual(parseAnnotations(note).map(item => item.body), ['one', 'two', 'three']);
  assert.ok(!/\n\n\n/.test(note), 'no doubled blank lines');
});

test('editing replaces in place; an empty body deletes; other text is untouched', () => {
  let note = writeAnnotation(GENERATED, entry(H1, 'one'), order);
  note = writeAnnotation(note, entry(H2, 'two'), order);
  const edited = writeAnnotation(note, entry(H1, 'one, revised'), order);
  assert.deepEqual(parseAnnotations(edited).map(item => item.body), ['one, revised', 'two']);
  const removed = writeAnnotation(edited, entry(H1, '  '), order);
  assert.deepEqual(parseAnnotations(removed).map(item => item.body), ['two']);
  assert.ok(removed.startsWith(GENERATED));
  assert.equal(writeAnnotation(GENERATED, entry(H1, ''), order), GENERATED);
});

test('a note without 我的理解 gets both sections before # 提问 and 人工复核 blocks', () => {
  const old = '# Title\n\n## Takeaways\n\nx\n\n## 人工复核\n\n- [x] ok\n\n# 提问\n\n## 1\n\nQ：a\n';
  const note = writeAnnotation(old, entry(H1, 'mine'), order);
  assert.ok(note.startsWith('# Title\n\n## Takeaways\n\nx\n\n## 我的理解\n\n## 段落批注\n\n> [!quote]'));
  assert.ok(note.endsWith('mine\n\n## 人工复核\n\n- [x] ok\n\n# 提问\n\n## 1\n\nQ：a\n'));
});

test('the section ends at the next level-2 heading, and headings in code fences do not count', () => {
  const note = `# T\n\n## 段落批注\n\n> [!quote] x %%pw:${H1.slice(0, 12)}%%\n> q\n\n\`\`\`\n## 段落批注\n\`\`\`\n### mine\n\n## 人工复核\n\n- [ ] y\n`;
  assert.deepEqual(parseAnnotations(note), [{ id: H1.slice(0, 12), quote: 'q', body: '```\n## 段落批注\n```\n### mine' }]);
  const added = writeAnnotation(note, entry(H2, 'two'), order);
  assert.ok(added.includes('### mine\n\n> [!quote] [[p.pdf#page=3|p.3]] %%pw:bbbbbbbbbbbb%%\n> Paragraph b text.\n\ntwo\n\n## 人工复核'));
});

test('an orphaned entry, found again by its quote, is replaced under the new anchor', () => {
  const note = writeAnnotation(GENERATED, entry(H1, 'old words'), order);
  const moved = writeAnnotation(note, entry(H3, 'old words'), order, H1.slice(0, 12));
  assert.deepEqual(parseAnnotations(moved).map(item => item.id), [H3.slice(0, 12)]);
});

test('entries the paper no longer has keep their place; new ones go after them only when later', () => {
  const stale = 'd'.repeat(12);
  const note = `${GENERATED}\n## 段落批注\n\n> [!quote] x %%pw:${stale}%%\n> gone\n\nkept\n`;
  const added = writeAnnotation(note, entry(H1, 'one'), order);
  assert.deepEqual(parseAnnotations(added).map(item => item.body), ['kept', 'one']);
});

test('quotes are one short line and match the paragraph they came from', () => {
  const long = `${'word '.repeat(40)}end`;
  const quote = quoteText(long);
  assert.ok(quote.endsWith('…') && quote.length <= 101 && !quote.includes('\n'));
  assert.equal(quoteText('a %% b\n c'), 'a % b c');
  assert.ok(quoteMatches(quote.replace(/…$/, ''), long));
  assert.ok(quoteMatches('Short one.', 'Short one.'));
  assert.ok(!quoteMatches('Short', 'Short one.'), 'short prefixes are too ambiguous');
});

test('a quote never stops inside a formula or an HTML tag', () => {
  const math = `${'a'.repeat(80)} the system, $T ^ { * } \\sim 30$ well below`;
  assert.equal(quoteText(math), `${'a'.repeat(80)} the system,…`);
  const closed = `${'a'.repeat(60)} $x$ and $y$ ${'b'.repeat(60)}`;
  assert.equal((quoteText(closed).match(/\$/g) ?? []).length, 4);
  const tag = `${'a'.repeat(95)} m<sup>3</sup> more`;
  assert.equal(quoteText(tag), `${'a'.repeat(95)} m…`);
  assert.ok(quoteMatches(quoteText(math).replace(/…$/, ''), math));
});

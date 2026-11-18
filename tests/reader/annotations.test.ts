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

test('quotes survive source-proven OCR and inline-format corrections without changing their stored text', () => {
  const old = 'The change from $- 4 0 \\mathrm{t}\\mathbf{0} - 3 0 ^{\\circ}\\mathrm{C}$';
  const corrected = 'The change from -40 to -30 °C for the material requires additional structural analysis.';
  assert.ok(quoteMatches(old, corrected));
  assert.ok(!quoteMatches(old, corrected.replace('-30', '-35')), 'different measurements stay different');
  assert.ok(!quoteMatches('$\\mathbf{x}$', 'x is the measured response.'), 'markup cannot make a short quote safe');
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

test('an entry whose pw: marker was damaged stays its own entry; editing or deleting its neighbour keeps it', () => {
  let note = writeAnnotation(GENERATED, entry(H1, 'one'), order);
  note = writeAnnotation(note, entry(H2, 'two\n\nsecond paragraph of two'), order);
  const damaged = note.replace(`%%pw:${H2.slice(0, 12)}%%`, '%%pw:typo-bbbbbbbbbbbb%%');
  const broken = '> [!quote] [[p.pdf#page=3|p.3]] %%pw:typo-bbbbbbbbbbbb%%\n> Paragraph b text.\n\ntwo\n\nsecond paragraph of two\n';
  assert.deepEqual(parseAnnotations(damaged), [
    { id: H1.slice(0, 12), quote: 'Paragraph a text.', body: 'one' },
    { id: 'typo-bbbbbbbbbbbb', quote: 'Paragraph b text.', body: 'two\n\nsecond paragraph of two', broken: true },
  ]);
  const edited = writeAnnotation(damaged, entry(H1, 'one, revised'), order);
  assert.ok(edited.endsWith(`one, revised\n\n${broken}`), edited);
  const removed = writeAnnotation(damaged, entry(H1, ''), order);
  assert.ok(removed.endsWith(`## 段落批注\n\n${broken}`), removed);
  // A damaged entry is never taken for the paragraph its marker resembles.
  const again = writeAnnotation(damaged, entry(H2, 'new two'), order);
  assert.ok(again.includes(broken) && again.includes(`%%pw:${H2.slice(0, 12)}%%\n> Paragraph b text.\n\nnew two`));
});

test('a marker in a code fence or an ordinary quote callout in a body is part of that body', () => {
  const body = `example:\n\n\`\`\`markdown\n> [!quote] x %%pw:${H2.slice(0, 12)}%%\n> sample\n\`\`\`\n\n> [!quote] Someone else\n> a quote I like`;
  let note = writeAnnotation(GENERATED, entry(H1, body), order);
  assert.deepEqual(parseAnnotations(note).map(item => [item.id, item.body]), [[H1.slice(0, 12), body]]);
  note = writeAnnotation(note, entry(H2, 'two'), order);
  assert.deepEqual(parseAnnotations(note).map(item => [item.id, item.body]), [[H1.slice(0, 12), body], [H2.slice(0, 12), 'two']]);
  note = writeAnnotation(note, entry(H2, ''), order);
  assert.deepEqual(parseAnnotations(note).map(item => [item.id, item.body]), [[H1.slice(0, 12), body]]);
});

test('the loose quote key keeps signs, decimal points and magnitudes of numbers', () => {
  const say = (value: string) => `${value} in the calibrated chamber.`;
  assert.ok(!quoteMatches('The calibrated operating temperature was -40 °C', say('The calibrated operating temperature was +40 °C')));
  assert.ok(!quoteMatches('The calibrated operating temperature was -40 °C', say('The calibrated operating temperature was 40 °C')));
  assert.ok(!quoteMatches('The measured loading was 1.0 percent', say('The measured loading was 10 percent')));
  assert.ok(!quoteMatches('The measured modulus was 10^{3} Pa at rest', say('The measured modulus was 103 Pa at rest')));
  assert.ok(!quoteMatches('The measured modulus was 10^{-3} Pa at rest', say('The measured modulus was 10^{3} Pa at rest')));
  assert.ok(!quoteMatches('The uncertainty was \\pm 5 percent overall', say('The uncertainty was 5 percent overall')));
  // The same values in different typography still match.
  assert.ok(quoteMatches('The calibrated operating temperature was −40 °C', say('The calibrated operating temperature was -40 ℃')));
  assert.ok(quoteMatches('The measured modulus was 10<sup>−3</sup> Pa at rest', say('The measured modulus was $10^{-3}$ Pa at rest')));
  assert.ok(quoteMatches('The measured modulus was 10³ Pa at rest', say('The measured modulus was 10^{3} Pa at rest')));
  assert.ok(quoteMatches('The measured loading was 1 . 0 percent', say('The measured loading was $1.0$ percent')));
  assert.ok(quoteMatches('A well-known <em>effect</em>, see Fig. 2.', 'A well known effect, see Fig. 2. More text follows here.'));
  assert.ok(quoteMatches('The range was 10–20 K for every sample', say('The range was 10-20 K for every sample')));
});

test('a generated page link with a truncated pw: marker still starts its own, untouched entry', () => {
  let note = writeAnnotation(GENERATED, entry(H1, 'one'), order);
  note = writeAnnotation(note, entry(H2, 'two, written by hand'), order);
  const marker = `%%pw:${H2.slice(0, 12)}%%`;
  for (const damage of [marker.slice(0, -1), marker.slice(0, -2), `%pw:${H2.slice(0, 12)}%%`]) {
    const damaged = note.replace(marker, damage);
    const broken = damaged.slice(damaged.indexOf('> [!quote] [[p.pdf#page=3|p.3]] ' + damage));
    assert.deepEqual(parseAnnotations(damaged).map(item => [item.body, item.broken]), [['one', undefined], ['two, written by hand', true]], damage);
    assert.ok(writeAnnotation(damaged, entry(H1, ''), order).endsWith(`## 段落批注\n\n${broken}`), damage);
    assert.ok(writeAnnotation(damaged, entry(H1, 'one, revised'), order).endsWith(`one, revised\n\n${broken}`), damage);
  }
  // Without the page link, a quote callout that merely mentions pw: is ordinary body text.
  const prose = writeAnnotation(GENERATED, entry(H1, '> [!quote] Notes on %%pw: markers\n> as I understand them'), order);
  assert.deepEqual(parseAnnotations(prose).map(item => item.body), ['> [!quote] Notes on %%pw: markers\n> as I understand them']);
});

test('the quote key tells apart leading decimals, comparisons and a number cut at the end of a quote', () => {
  assert.ok(!quoteMatches('The sample was heated to .5 percent', 'The sample was heated to 5 percent of its limit.'));
  assert.ok(quoteMatches('The sample was heated to .5 percent', 'The sample was heated to 0.5 percent of its limit.'));
  assert.ok(!quoteMatches('The measured signal was <0.5 percent', 'The measured signal was >0.5 percent in every run.'));
  assert.ok(!quoteMatches('The measured signal was <0.5 percent', 'The measured signal was 0.5 percent in every run.'));
  assert.ok(quoteMatches('The measured signal was &lt;0.5 percent', 'The measured signal was $<0.5$ percent in every run.'));
  assert.ok(!quoteMatches('The noise dropped by a factor of 1', 'The noise dropped by a factor of 10 after correction.'), 'fast prefix');
  assert.ok(!quoteMatches('The noise dropped by a <em>factor</em> of 1', 'The noise dropped by a factor of 10 after correction.'), 'loose prefix');
  assert.ok(!quoteMatches('The noise dropped by a factor of 1', 'The noise dropped by a factor of 1.5 after correction.'));
  assert.ok(quoteMatches('The noise dropped by a factor of 1', 'The noise dropped by a factor of 1 after correction.'));
  assert.ok(quoteMatches('The noise dropped by a factor of 10 after', 'The noise dropped by a factor of 10 after correction.'));
  // quoteText never cuts a number in two.
  const cut = quoteText(`${'a'.repeat(97)} 12345 more`);
  assert.equal(cut, `${'a'.repeat(97)}…`);
});

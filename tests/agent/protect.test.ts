import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { preserveHumanContent, protectedSpans } from '../../src/agent/notes/protect';

// Ported from legacy tests/test_pipeline_safety.py.

test('preserves human sections and is idempotent', () => {
  const original = '# Paper\nOld prose\n\n## 人工复核\n- [x] Checked by human\n\n<!-- user-notes:start -->\nMy observation\n<!-- user-notes:end -->\n\n<!-- intensive-reading:U01:start -->\nVerified correction\n<!-- intensive-reading:U01:end -->\n\n# 提问\n## 1\nQ：why\nA：because\n';
  const candidate = '# Paper\nNew prose\n\n## 人工复核\n- [ ] New ambiguity\n\n# 提问\nInvented dialog\n';
  const merged = preserveHumanContent(original, candidate);
  for (const phrase of ['My observation', 'Verified correction', 'Q：why', 'A：because', '- [x] Checked by human', '- [ ] New ambiguity']) assert.ok(merged.includes(phrase), phrase);
  assert.ok(!merged.includes('Invented dialog'));
  assert.ok(merged.includes('New prose') && !merged.includes('Old prose'));
  assert.equal(preserveHumanContent(original, merged), merged);
});

test('candidate keeps a new review when the old note has only chat', () => {
  const result = preserveHumanContent('# Paper\n# 提问\nQ：old\n', '# Paper\n## 人工复核\nReview prose\n- [ ] New check\n<!-- user-notes:start -->\n<!-- user-notes:end -->\n');
  assert.ok(result.includes('Review prose'));
  assert.ok(result.includes('<!-- user-notes:start -->'));
  assert.ok(result.includes('Q：old'));
});

test('a protected section ends at the next heading of the same or higher level', () => {
  const text = '# A\n## 人工复核\n- [x] a\n### detail\nkept\n## 研究背景\nnot protected\n# 提问\n## 1\nQ：x\n';
  const spans = protectedSpans(text).map(([start, end]) => text.slice(start, end));
  assert.deepEqual(spans, ['## 人工复核\n- [x] a\n### detail\nkept\n', '# 提问\n## 1\nQ：x\n']);
});

test('Human Review heading, overlapping blocks merge, mismatched intensive ids are not a block', () => {
  const text = '## Human Review\n<!-- user-notes:start -->\nx\n<!-- user-notes:end -->\n## next\n<!-- intensive-reading:A:start -->\ny\n<!-- intensive-reading:B:end -->\n';
  const spans = protectedSpans(text);
  assert.equal(spans.length, 1);
  assert.ok(text.slice(spans[0]![0], spans[0]![1]).includes('user-notes:end'));
});

test('a brand-new note is returned unchanged; a note without blocks gets an empty user-notes block only when it had blocks', () => {
  assert.equal(preserveHumanContent('', '# New\n'), '# New\n');
  assert.equal(preserveHumanContent('# Old\nplain\n', '# New\n'), '# New\n');
  const withChat = preserveHumanContent('# Old\n# 提问\n## 1\nQ：a\n\nA：b\n', '# New\nbody\n');
  assert.ok(withChat.endsWith('<!-- user-notes:start -->\n<!-- user-notes:end -->\n'));
  assert.ok(withChat.indexOf('body') < withChat.indexOf('# 提问'));
});

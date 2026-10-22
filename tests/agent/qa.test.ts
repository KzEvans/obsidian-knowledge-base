import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { insertQuestionAnswerSection, normalizeLatexDelimiters, pairConversationMessages } from '../../src/agent/chat/qa';
import { buildChatPrompt, MAX_OUTLINK_NOTES } from '../../src/agent/chat/prompt';
import { isReviewed, readScalar, setReviewStatus, splitFrontmatter } from '../../src/agent/notes/frontmatter';
import type { ChatMessage } from '../../src/agent/settings';

const at = '2026-10-21T00:00:00Z';
const qa: ChatMessage[] = [
  { role: 'user', text: '单位是否正确？', at },
  { role: 'assistant', text: '正确，见 Table 1。', at },
];

// Ported from legacy tests/test_plugin_review.js (insertQuestionAnswerSection part).

test('creates # 提问 and numbers entries from 1', () => {
  const note = '---\ntype: paper\nstatus: reviewed\nreviewed: true\n---\n# Paper\n';
  const withQa = insertQuestionAnswerSection(note, qa);
  assert.match(withQa, /# 提问\n\n## 1\n\nQ：单位是否正确？\n\nA：正确，见 Table 1。\n$/);
  const withMore = insertQuestionAnswerSection(withQa, qa);
  assert.match(withMore, /## 2\n\nQ：单位是否正确？/);
  assert.equal(withMore.match(/^# 提问$/gm)?.length, 1);
});

test('appends inside an existing # 提问 followed by other content', () => {
  const note = '---\nstatus: draft\n---\n# Paper\n\n# 提问\n\n## 1\n\nQ：旧\n\nA：旧\n\n# Notes\nkept\n';
  const result = insertQuestionAnswerSection(note, qa);
  assert.match(result, /A：旧\n\n## 2\n\nQ：单位是否正确？\n\nA：正确，见 Table 1。\n\n# Notes\nkept\n$/);
});

test('numbering continues from the highest existing number', () => {
  const note = '# P\n\n# 提问\n\n## 3\n\nQ：a\n\nA：b\n\n## 7\n\nQ：c\n\nA：d\n';
  assert.match(insertQuestionAnswerSection(note, qa), /## 8\n\nQ：单位是否正确？/);
});

test('writing Q&A leaves status and reviewed untouched', () => {
  const note = setReviewStatus('---\ntype: paper\nstatus: draft\nreviewed: false\n---\n# Paper\n', true);
  const after = insertQuestionAnswerSection(note, qa);
  assert.equal(splitFrontmatter(after).frontmatter, splitFrontmatter(note).frontmatter);
  assert.ok(isReviewed(after));
});

test('pairs unanswered questions, attachments and errors like the old plugin', () => {
  const pairs = pairConversationMessages([
    { role: 'user', text: 'a', at, attachments: [{ name: 'fig.png', type: 'image/png', size: 1, isImage: true }] },
    { role: 'error', text: 'boom', at },
    { role: 'user', text: 'b', at },
    { role: 'assistant', text: ' ', at },
  ]);
  assert.deepEqual(pairs, [{ question: 'a\n\n附件：fig.png', answer: '（尚无回答）' }, { question: 'b', answer: '（尚无回答）' }]);
  assert.equal(insertQuestionAnswerSection('# P\n', []), '# P\n');
});

test('status toggle writes status and reviewed together', () => {
  const draft = '---\ntype: paper\nstatus: "draft"\nreviewed: false\ntitle: x\n---\nbody\n';
  const reviewed = setReviewStatus(draft, true);
  const fm = splitFrontmatter(reviewed).frontmatter!;
  assert.equal(readScalar(fm, 'status'), 'reviewed');
  assert.equal(readScalar(fm, 'reviewed'), 'true');
  assert.equal(readScalar(fm, 'title'), 'x');
  assert.ok(reviewed.endsWith('---\nbody\n'));
  const back = setReviewStatus(reviewed, false);
  assert.equal(readScalar(splitFrontmatter(back).frontmatter!, 'status'), 'draft');
  assert.equal(readScalar(splitFrontmatter(back).frontmatter!, 'reviewed'), 'false');
  assert.ok(setReviewStatus('no frontmatter\n', true).startsWith('---\nstatus: "reviewed"\nreviewed: true\n---\n'));
});

test('LaTeX delimiters are converted outside code only', () => {
  assert.equal(normalizeLatexDelimiters('a \\(x\\) b \\[y\\] `\\(z\\)`\n```\n\\(k\\)\n```'), 'a $x$ b $$y$$ `\\(z\\)`\n```\n\\(k\\)\n```');
});

test('chat prompt: at most 12 outlinks, purpose capped at 6000 characters, full text only on a fresh session', () => {
  const outlinks = Array.from({ length: 15 }, (_, index) => ({ path: `n${index}.md`, text: 'x' }));
  const prompt = buildChatPrompt({
    notePath: 'wiki/a.md', noteText: 'note', paper: { pdfPath: 'p.pdf', text: 'FULLTEXT' }, outlinks, purpose: 'p'.repeat(7000), attachments: [], question: 'Q?',
  });
  assert.equal(prompt.match(/<linked_note /g)?.length, MAX_OUTLINK_NOTES);
  assert.equal(/<knowledge_purpose>\n(p+)\n/.exec(prompt)?.[1]?.length, 6000);
  assert.ok(prompt.includes('<paper_fulltext>\nFULLTEXT'));
  const resumed = buildChatPrompt({ notePath: 'wiki/a.md', noteText: 'note', paperInEarlierTurn: true, outlinks: [], attachments: [], question: 'Q?' });
  assert.ok(!resumed.includes('<paper_fulltext>'));
  assert.ok(resumed.includes('全文已在本会话前文提供'));
});

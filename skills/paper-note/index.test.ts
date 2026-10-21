import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PAPER_NOTE_SKILL } from './index';
import { SECTIONS } from './lint';

test('the skill text includes SKILL.md and its references', () => {
  assert.ok(PAPER_NOTE_SKILL.startsWith('# paper-note'));
  assert.ok(PAPER_NOTE_SKILL.includes('## 说人话'));
  assert.ok(PAPER_NOTE_SKILL.includes('## 禁用词'));
});

test('the skill lists the 9 sections lint expects, in order', () => {
  const template = /```markdown\n([\s\S]*?)```/.exec(PAPER_NOTE_SKILL)?.[1] ?? '';
  assert.deepEqual([...template.matchAll(/^## (.+)$/gm)].map(match => match[1]), [...SECTIONS]);
  assert.ok(template.includes('<!-- abstract-translation -->'));
});

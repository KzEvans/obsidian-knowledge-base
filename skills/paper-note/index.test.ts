import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PAPER_NOTE_SKILL } from './index';
import { lintNote } from './lint';

test('the skill text loads and lint returns the frozen result shape', () => {
  assert.ok(PAPER_NOTE_SKILL.includes('paper-note'));
  const result = lintNote('');
  assert.deepEqual(Object.keys(result).sort(), ['length', 'ok', 'problems']);
});

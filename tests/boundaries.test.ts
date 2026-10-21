import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ESLint } from 'eslint';
// @ts-expect-error -- plain ESM config module without type declarations
import { boundaries } from '../eslint.boundaries.mjs';

const eslint = new ESLint({ cwd: process.cwd(), overrideConfigFile: true, overrideConfig: boundaries as ESLint.Options['overrideConfig'] });

async function messages(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.map(message => message.ruleId ?? message.message);
}

const cases: Array<[file: string, code: string, allowed: boolean]> = [
  ['src/core/store.ts', "import x from '../library/sync';", false],
  ['src/core/store.ts', "import x from './hash';", true],
  ['src/library/pipeline.ts', "import x from '../core/store';", true],
  ['src/library/pipeline.ts', "import x from '../agent/adapter';", false],
  ['src/library/pipeline.ts', "import x from '../reader/view';", false],
  ['src/agent/notes.ts', "import x from '../library';", false],
  ['src/agent/notes.ts', "import x from '../reader/render';", false],
  ['src/agent/notes.ts', "import x from '../core/events';", true],
  ['src/reader/view.ts', "import x from './selection';", false],
  ['src/reader/view.ts', "import x from './selection/popup';", false],
  ['src/reader/view.ts', "import x from '../agent';", false],
  ['src/reader/view.ts', "import x from './render';", true],
  ['src/reader/bilingual/layers.ts', "import x from '../selection/popup';", false],
  ['src/reader/bilingual/layers.ts', "import x from '../../core/types';", true],
  ['src/reader/selection/popup.ts', "import x from '../render';", false],
  ['src/reader/selection/popup.ts', "import x from '..';", false],
  ['src/reader/selection/popup.ts', "import x from '../../library';", false],
  ['src/reader/selection/popup.ts', "import x from '../../core/qwen-mt';", true],
  ['src/reader/selection/popup.ts', "import x from './geometry';", true],
];

test('module boundary rules allow only core as a shared dependency', async () => {
  for (const [file, code, allowed] of cases) {
    const found = await messages(file, code);
    assert.equal(found.length === 0, allowed, `${file}: ${code} → ${found.join(', ') || 'no errors'}`);
  }
});

test('only library may name the store writer', async () => {
  assert.deepEqual(await messages('src/reader/view.ts', 'let StoreWriter = 1;'), ['no-restricted-syntax']);
  assert.ok((await messages('src/agent/notes.ts', 'const StoreWriter = 0;')).includes('no-restricted-syntax'));
  assert.deepEqual(await messages('src/library/pipeline.ts', 'const StoreWriter = 0;'), []);
});

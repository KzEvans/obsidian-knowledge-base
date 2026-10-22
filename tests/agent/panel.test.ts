import { strict as assert } from 'node:assert';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const electron = new URL('../stubs/electron.ts', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => specifier === 'electron' ? { url: electron, shortCircuit: true } : next(specifier, context) });
const { NoteChat } = await import('../../src/agent/chat/panel');

test('rapid sends during context refresh reserve only one turn and unload prevents continuation', async () => {
  const instance: unknown = Object.create(NoteChat.prototype);
  assert.ok(instance instanceof NoteChat);
  const chat = instance;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let refreshes = 0;
  Reflect.set(chat, 'attachments', []);
  Reflect.set(chat, 'refs', { input: { value: 'Question', focus: () => undefined } });
  Reflect.set(chat, 'noteContext', { file: { path: 'paper.md' } });
  Reflect.set(chat, 'refreshContext', async () => { refreshes++; await gate; });
  const first = chat['send']();
  const second = chat['send']();
  const beforeRelease = refreshes;
  Reflect.set(chat, 'disposed', true);
  release?.();
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(beforeRelease, 1);
  assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'));
});

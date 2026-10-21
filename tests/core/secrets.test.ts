import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { App } from 'obsidian';
import { LEGACY_SECRET_IDS, SECRET_IDS, createSecretAccess, errorMessage, importLegacySecrets, redact, registerSecretForRedaction } from '../../src/core/secrets';
import { EventBus } from '../../src/core/events';
import { parseGlossary, formatGlossary, readCoreSettings } from '../../src/core/settings';

function fakeApp(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return { store, app: { secretStorage: { getSecret: (id: string) => store.get(id) ?? null, setSecret: (id: string, value: string) => { store.set(id, value); } } } as unknown as App };
}

test('known secrets, bearer tokens, sk- keys and signed URL parameters are redacted', () => {
  registerSecretForRedaction('custom-secret-value-123');
  const text = 'failed with custom-secret-value-123 and Bearer abc.def-ghi and sk-ABCDEFGHIJKLMNOP1234 at https://oss.example/x.zip?OSSAccessKeyId=AK1&Signature=zz&Expires=9 ok'; // scan:allow
  const result = redact(text);
  for (const leaked of ['custom-secret-value-123', 'abc.def-ghi', 'ABCDEFGHIJKLMNOP1234', 'AK1', 'Signature=zz']) assert.ok(!result.includes(leaked), leaked);
  assert.match(result, /ok$/);
  assert.equal(errorMessage(new Error('token custom-secret-value-123 rejected')), 'token [已隐藏] rejected');
});

test('reading a secret registers it for redaction', () => {
  const { app } = fakeApp({ [SECRET_IDS.mineru]: '  read-secret-xyz-987  ' });
  assert.equal(createSecretAccess(app).get('mineru'), 'read-secret-xyz-987');
  assert.equal(redact('x read-secret-xyz-987 y'), 'x [已隐藏] y');
});

test('legacy secrets are copied once and never overwrite a newer value; old entries are kept', () => {
  const { app, store } = fakeApp({ [LEGACY_SECRET_IDS.mineru]: 'old-mineru-token-1', [LEGACY_SECRET_IDS.dashscope]: 'old-dashscope-key-1', [SECRET_IDS.dashscope]: 'new-dashscope-key-2' });
  assert.deepEqual(importLegacySecrets(app), ['mineru']);
  assert.equal(store.get(SECRET_IDS.mineru), 'old-mineru-token-1');
  assert.equal(store.get(SECRET_IDS.dashscope), 'new-dashscope-key-2');
  assert.equal(store.get(LEGACY_SECRET_IDS.mineru), 'old-mineru-token-1');
  assert.deepEqual(importLegacySecrets(app), []);
});

test('event bus isolates a failing listener and supports unsubscribe', () => {
  const bus = new EventBus();
  const seen: string[] = [];
  const original = console.error;
  console.error = () => undefined;
  try {
    bus.on('pipeline:paused', () => { throw new Error('bad listener'); });
    const off = bus.on('pipeline:paused', payload => seen.push(String(payload.paused)));
    bus.emit('pipeline:paused', { paused: true });
    off();
    bus.emit('pipeline:paused', { paused: false });
  } finally { console.error = original; }
  assert.deepEqual(seen, ['true']);
});

test('glossary text round-trips and malformed lines are skipped', () => {
  const terms = parseGlossary('dielectric elastomer = 介电弹性体\n# comment\nno separator\n  actuator=驱动器  \n');
  assert.deepEqual(terms, [{ source: 'dielectric elastomer', target: '介电弹性体' }, { source: 'actuator', target: '驱动器' }]);
  assert.equal(formatGlossary(terms), 'dielectric elastomer = 介电弹性体\nactuator = 驱动器');
});

test('core settings ignore malformed saved values', () => {
  assert.deepEqual(readCoreSettings({ qwenMtEndpoint: 5, glossary: [{ source: 'a', target: 'b' }, { source: 1 }, null] }).glossary, [{ source: 'a', target: 'b' }]);
  assert.match(readCoreSettings(undefined).qwenMtEndpoint, /dashscope/);
});

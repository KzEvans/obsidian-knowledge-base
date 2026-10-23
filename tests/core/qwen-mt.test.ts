import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { RequestUrlParam } from 'obsidian';
import type { HttpResponse } from '../../src/core/http';
import { PLACEHOLDER_FALLBACK_MODEL, PlaceholderMismatchError, QwenMtError, TRANSLATOR_VERSION, createQwenMtClient, protectSpans, restoreSpans, termsFor, termsKey, translationIsCurrent } from '../../src/core/qwen-mt';

const KEY = 'test-key-not-real-0000';

function client(reply: (masked: string, body: Record<string, unknown>) => Partial<HttpResponse> & { status: number }) {
  const calls: RequestUrlParam[] = [];
  const http = async (request: RequestUrlParam): Promise<HttpResponse> => {
    calls.push(request);
    const body = JSON.parse(request.body as string) as { messages: Array<{ content: string }> } & Record<string, unknown>;
    return { headers: {}, text: '', arrayBuffer: new ArrayBuffer(0), json: undefined, ...reply(body.messages[0]!.content, body) };
  };
  return { calls, mt: createQwenMtClient(http, () => KEY, () => '') };
}
const ok = (content: string) => ({ status: 200, json: { choices: [{ message: { content } }] } });

test('inline math and sup/sub are masked before sending and restored after', async () => {
  const { mt, calls } = client(masked => ok(masked.replace('The modulus', '模量').replace('of ZrO', '的 ZrO')));
  const text = 'The modulus $Y=0.11$ MPa of ZrO<sub>2</sub> at 10<sup>3</sup> Hz';
  const result = await mt.translate({ text, model: 'qwen-mt-plus', terms: [], timeoutMs: 1000 });
  const sent = JSON.parse(calls[0]!.body as string) as { messages: Array<{ content: string }> };
  assert.equal(sent.messages[0]!.content, 'The modulus ⟦1⟧ MPa of ZrO⟦2⟧ at 10⟦3⟧ Hz');
  assert.equal(result, '模量 $Y=0.11$ MPa 的 ZrO<sub>2</sub> at 10<sup>3</sup> Hz');
});

test('display math and escaped dollars are handled; a literal placeholder in the source is protected', () => {
  const { text, spans } = protectSpans('cost \\$5 and $$E=mc^2$$ with ⟦9⟧');
  assert.equal(text, 'cost \\$5 and ⟦1⟧ with ⟦2⟧');
  assert.deepEqual(spans, ['$$E=mc^2$$', '⟦9⟧']);
  assert.equal(restoreSpans('⟦2⟧ 与 ⟦1⟧', spans), '⟦9⟧ 与 $$E=mc^2$$');
});

test('missing, duplicated, extra or out-of-range placeholders are rejected', () => {
  const spans = ['$a$', '$b$'];
  for (const bad of ['只有 ⟦1⟧', '⟦1⟧ ⟦1⟧ ⟦2⟧', '⟦1⟧ ⟦2⟧ ⟦3⟧', '⟦0⟧ ⟦1⟧ ⟦2⟧', '没有占位符']) {
    assert.throws(() => restoreSpans(bad, spans), PlaceholderMismatchError, bad);
  }
  assert.equal(restoreSpans('无公式', []), '无公式');
});

test('a placeholder mismatch retries the whole sentence once with the fallback model, keeping word order', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const { mt } = client((masked, body) => {
    bodies.push(body);
    // Qwen-MT drops a placeholder; the general model reorders it the Chinese way.
    return ok(body.model === PLACEHOLDER_FALLBACK_MODEL ? '在 10⟦2⟧ 赫兹下测得的模量为 ⟦1⟧ MPa' : '模量 MPa 在 10 赫兹');
  });
  const result = await mt.translate({ text: 'The modulus $Y=0.11$ MPa at 10<sup>3</sup> Hz', model: 'qwen-mt-plus', terms: [], timeoutMs: 1000 });
  assert.equal(result, '在 10<sup>3</sup> 赫兹下测得的模量为 $Y=0.11$ MPa');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1]!.model, PLACEHOLDER_FALLBACK_MODEL);
  assert.equal(bodies[1]!.translation_options, undefined);
  const messages = bodies[1]!.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]!.role, 'system');
  assert.match(messages[0]!.content, /⟦1⟧/);
  assert.equal(messages[1]!.content, 'The modulus ⟦1⟧ MPa at 10⟦2⟧ Hz');
});

test('the fallback receives the glossary terms used by this text as instructions', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const { mt } = client((masked, body) => { bodies.push(body); return ok(bodies.length === 1 ? '坏' : '驱动器的模量 ⟦1⟧'); });
  await mt.translate({ text: 'actuator modulus $Y$', model: 'm', terms: [{ source: 'actuator', target: '驱动器' }, { source: 'gel', target: '凝胶' }], timeoutMs: 1000 });
  const system = (bodies[1]!.messages as Array<{ content: string }>)[0]!.content;
  assert.match(system, /actuator → 驱动器/);
  assert.doesNotMatch(system, /凝胶/);
});

test('a broken fallback gets one correction round naming the exact placeholders, then the text fails', async () => {
  const { mt, calls } = client(() => ok('模量 ⟦1⟧ ⟦1⟧ ⟦3⟧'));
  await assert.rejects(mt.translate({ text: 'modulus $Y$ and $Z$ MPa', model: 'm', terms: [], timeoutMs: 1000 }), PlaceholderMismatchError);
  assert.equal(calls.length, 3);
  const correction = JSON.parse(calls[2]!.body as string) as { messages: Array<{ role: string; content: string }> };
  assert.deepEqual(correction.messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
  assert.match(correction.messages[3]!.content, /缺少 ⟦2⟧/);
  assert.match(correction.messages[3]!.content, /重复了 ⟦1⟧/);
  assert.match(correction.messages[3]!.content, /多出了原文没有的 ⟦3⟧/);
});

test('the correction round can rescue the translation', async () => {
  let call = 0;
  const { mt } = client(() => ok(['坏', '模量 ⟦1⟧', '模量 ⟦1⟧ 与 ⟦2⟧'][call++]!));
  assert.equal(await mt.translate({ text: 'modulus $Y$ and $Z$', model: 'm', terms: [], timeoutMs: 1000 }), '模量 $Y$ 与 $Z$');
});

test('text without protected spans never reaches the fallback', async () => {
  const { mt, calls } = client(() => ok('模量很低。'));
  assert.equal(await mt.translate({ text: 'The modulus is low.', model: 'm', terms: [], timeoutMs: 1000 }), '模量很低。');
  assert.equal(calls.length, 1);
});

test('stored translations of formula text from the old method are not reused; prose ones are', () => {
  const terms = [{ source: 'modulus', target: '模量' }];
  const formula = 'The modulus $Y$ is low.';
  const prose = 'The modulus is low.';
  assert.equal(translationIsCurrent({ termsKey: termsKey(formula, terms) }, formula, terms), false);
  assert.equal(translationIsCurrent({ termsKey: termsKey(formula, terms), translator: TRANSLATOR_VERSION }, formula, terms), true);
  assert.equal(translationIsCurrent({ termsKey: termsKey(formula, terms), translator: 2 }, formula, terms), true);
  assert.equal(translationIsCurrent({ termsKey: termsKey(prose, terms) }, prose, terms), true);
  assert.equal(translationIsCurrent({ termsKey: 'other' }, prose, terms), false);
  assert.equal(translationIsCurrent(undefined, prose, terms), false);
});

test('HTTP errors do not enter the fallback', async () => {
  const { mt, calls } = client(() => ({ status: 503 }));
  await assert.rejects(mt.translate({ text: 'modulus $Y$ MPa', model: 'm', terms: [], timeoutMs: 1000 }), QwenMtError);
  assert.equal(calls.length, 1);
});

test('aborting fallback prevents further HTTP requests', async () => {
  const controller = new AbortController();
  let count = 0;
  const { mt, calls } = client(() => {
    if (++count === 2) controller.abort();
    return ok('模量');
  });
  await assert.rejects(mt.translate({ text: 'modulus $Y$ MPa', model: 'm', terms: [], timeoutMs: 1000, signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(calls.length, 2);
});

test('an already aborted translation sends no HTTP request', async () => {
  const controller = new AbortController();
  controller.abort();
  const { mt, calls } = client(() => ok('译文'));
  await assert.rejects(mt.translate({ text: 'modulus $Y$', model: 'm', terms: [], timeoutMs: 1000, signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(calls.length, 0);
});

test('only glossary terms present in the text are sent, on word boundaries', async () => {
  const terms = [
    { source: 'dielectric elastomer', target: '介电弹性体' },
    { source: 'DE', target: '介电弹性体' },
    { source: 'actuator', target: '驱动器' },
    { source: 'Dielectric Elastomer', target: '重复' },
    { source: ' ', target: '空' },
  ];
  assert.deepEqual(termsFor('A Dielectric elastomer device (DEA) was built.', terms), [{ source: 'dielectric elastomer', target: '介电弹性体' }]);
  const { mt, calls } = client(masked => ok(masked));
  await mt.translate({ text: 'an actuator', model: 'm', terms, timeoutMs: 1000 });
  const body = JSON.parse(calls[0]!.body as string) as { translation_options: Record<string, unknown> };
  assert.deepEqual(body.translation_options, { source_lang: 'auto', target_lang: 'Chinese', terms: [{ source: 'actuator', target: '驱动器' }] });
  await mt.translate({ text: 'nothing relevant', model: 'm', terms, timeoutMs: 1000 });
  assert.equal((JSON.parse(calls[1]!.body as string) as { translation_options: Record<string, unknown> }).translation_options.terms, undefined);
});

test('termsKey changes only when a term used by this text changes', () => {
  const text = 'the actuator';
  const base = termsKey(text, [{ source: 'actuator', target: '驱动器' }]);
  assert.equal(termsKey(text, [{ source: 'actuator', target: '驱动器' }, { source: 'gel', target: '凝胶' }]), base);
  assert.notEqual(termsKey(text, [{ source: 'actuator', target: '致动器' }]), base);
});

test('API errors are classified for retry and never echo the key', async () => {
  for (const [status, retryable] of [[401, false], [429, true], [503, true], [400, false]] as const) {
    const { mt } = client(() => ({ status, json: { error: { message: 'detail' } } }));
    await assert.rejects(mt.translate({ text: 'x', model: 'm', terms: [], timeoutMs: 1000 }),
      (error: unknown) => error instanceof QwenMtError && error.retryable === retryable && !error.message.includes(KEY));
  }
  const empty = client(() => ({ status: 200, json: { choices: [] } }));
  await assert.rejects(empty.mt.translate({ text: 'x', model: 'm', terms: [], timeoutMs: 1000 }), (error: unknown) => error instanceof QwenMtError && error.retryable);
});

test('timeouts and aborts reject without waiting for the request', async () => {
  const hanging = createQwenMtClient(() => new Promise(() => undefined), () => KEY, () => '');
  await assert.rejects(hanging.translate({ text: 'x', model: 'm', terms: [], timeoutMs: 10 }), /秒内没有返回/);
  const controller = new AbortController();
  const pending = hanging.translate({ text: 'x', model: 'm', terms: [], timeoutMs: 10_000, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => (error as Error).name === 'AbortError');
});

test('endpoint must be https and a compatible-mode path', async () => {
  const http = async (): Promise<HttpResponse> => ok('x') as HttpResponse;
  await assert.rejects(createQwenMtClient(http, () => KEY, () => 'http://example.com/compatible-mode/v1').translate({ text: 'x', model: 'm', terms: [], timeoutMs: 100 }), /https/);
  await assert.rejects(createQwenMtClient(http, () => KEY, () => 'https://example.com/v2').translate({ text: 'x', model: 'm', terms: [], timeoutMs: 100 }), /compatible-mode/);
});

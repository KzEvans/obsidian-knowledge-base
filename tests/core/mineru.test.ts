import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import type { RequestUrlParam } from 'obsidian';
import type { HttpResponse } from '../../src/core/http';
import { MinerUError, contentListName, createMinerUClient, unpackArchive } from '../../src/core/mineru';

const TOKEN = 'test-token-not-real-0000';
const SHA = 'f'.repeat(64);

function fakeHttp(responses: Array<Partial<HttpResponse> & { status: number }>) {
  const calls: RequestUrlParam[] = [];
  const http = async (request: RequestUrlParam): Promise<HttpResponse> => {
    calls.push(request);
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return { headers: {}, text: '', arrayBuffer: new ArrayBuffer(0), json: undefined, ...next };
  };
  return { http, calls };
}

test('upload request uses the VLM contract and a hashed data id, and returns the batch', async () => {
  const { http, calls } = fakeHttp([{ status: 200, json: { code: 0, data: { batch_id: 'b1', file_urls: ['https://upload.example/x?Signature=abc'] } } }]); // scan:allow
  const client = createMinerUClient(http, () => TOKEN);
  assert.deepEqual(await client.requestUpload(SHA), { batchId: 'b1', uploadUrl: 'https://upload.example/x?Signature=abc' }); // scan:allow
  const body = JSON.parse(calls[0]!.body as string) as Record<string, unknown>;
  assert.equal(body.model_version, 'vlm');
  assert.equal(body.enable_formula, true);
  assert.deepEqual(body.files, [{ name: 'paper.pdf', data_id: 'pw_' + SHA.slice(0, 24) }]);
  assert.equal(calls[0]!.headers?.Authorization, `Bearer ${TOKEN}`);
});

test('the pre-signed upload carries no Authorization header', async () => {
  const { http, calls } = fakeHttp([{ status: 200 }]);
  await createMinerUClient(http, () => TOKEN).upload('https://upload.example/x', new ArrayBuffer(4));
  assert.equal(calls[0]!.method, 'PUT');
  assert.equal(calls[0]!.headers, undefined);
});

test('poll maps running progress, done and failed states', async () => {
  const { http } = fakeHttp([
    { status: 200, json: { code: 0, data: { extract_result: [{ state: 'running', extract_progress: { extracted_pages: 3, total_pages: 12 } }] } } },
    { status: 200, json: { code: 0, data: { extract_result: [{ state: 'waiting-file' }] } } },
    { status: 200, json: { code: 0, data: { extract_result: [{ state: 'done', full_zip_url: 'https://cdn.example/r.zip' }] } } },
    { status: 200, json: { code: 0, data: { extract_result: [{ state: 'failed', err_msg: 'bad pdf' }] } } },
  ]);
  const client = createMinerUClient(http, () => TOKEN);
  assert.deepEqual(await client.poll('b1'), { state: 'running', progress: { done: 3, total: 12 } });
  assert.deepEqual(await client.poll('b1'), { state: 'pending', progress: undefined });
  assert.deepEqual(await client.poll('b1'), { state: 'done', zipUrl: 'https://cdn.example/r.zip' });
  assert.deepEqual(await client.poll('b1'), { state: 'failed', error: 'bad pdf' });
});

test('credential errors are not retryable; rate limits and server errors are', async () => {
  const cases: Array<[number, boolean]> = [[401, false], [403, false], [429, true], [500, true], [400, false]];
  for (const [status, retryable] of cases) {
    const { http } = fakeHttp([{ status }]);
    await assert.rejects(createMinerUClient(http, () => TOKEN).poll('b'), (error: unknown) => error instanceof MinerUError && error.retryable === retryable);
  }
  await assert.rejects(createMinerUClient(fakeHttp([]).http, () => null).poll('b'), (error: unknown) => error instanceof MinerUError && !error.retryable);
});

test('error messages never contain the token', async () => {
  const { http } = fakeHttp([{ status: 401 }]);
  await assert.rejects(createMinerUClient(http, () => TOKEN).poll('b'), (error: unknown) => !String((error as Error).message).includes(TOKEN));
});

test('archives keep every member, including non-image files', () => {
  const zip = zipSync({ 'abc_content_list.json': strToU8('[]'), 'images/a.jpg': new Uint8Array([1]), 'abc_origin.pdf': strToU8('%PDF-1.7'), 'layout.json': strToU8('{}') });
  assert.deepEqual(Object.keys(unpackArchive(zip)).sort(), ['abc_content_list.json', 'abc_origin.pdf', 'images/a.jpg', 'layout.json']);
});

test('archives with traversal paths or without a content list are refused', () => {
  assert.throws(() => unpackArchive(zipSync({ '../evil.json': strToU8('x'), 'a_content_list.json': strToU8('[]') })), MinerUError);
  assert.throws(() => unpackArchive(zipSync({ 'full.md': strToU8('x') })), /content_list/);
  assert.equal(contentListName(['a_content_list.json', 'a_content_list_v2.json']), 'a_content_list.json');
  assert.equal(contentListName(['x/content_list.json', 'y/content_list.json']), undefined);
});

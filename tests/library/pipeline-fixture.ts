import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CropRequest, CropResult, Cropper } from '../../src/core/derive';
import { EventBus } from '../../src/core/events';
import type { EventMap, EventName } from '../../src/core/events';
import { sha256Bytes } from '../../src/core/hash';
import type { Logger } from '../../src/core/log';
import { MinerUError } from '../../src/core/mineru';
import type { MinerUClient, MinerUPoll } from '../../src/core/mineru';
import type { PdfDocument } from '../../src/core/obsidian-internal';
import type { QwenMtClient, TranslateRequest } from '../../src/core/qwen-mt';
import { FileStore } from '../../src/core/store';
import type { Manifest, Term } from '../../src/core/types';
import { Pipeline } from '../../src/library/pipeline/pipeline';
import type { PipelineDeps } from '../../src/library/pipeline/pipeline';
import { tempDir } from './helpers';

const encoder = new TextEncoder();

export const CONTENT_LIST = [
  { type: 'text', text: 'A Study of Things', text_level: 1, page_idx: 0, bbox: [100, 50, 900, 90] },
  { type: 'text', text: 'Abstract', text_level: 1, page_idx: 0, bbox: [100, 100, 300, 120] },
  { type: 'text', text: 'We show that dielectric elastomer works.', page_idx: 0, bbox: [100, 130, 900, 200] },
  ...Array.from({ length: 12 }, (_, index) => ({ type: 'text', text: `Paragraph number ${index + 1} explains a result.`, page_idx: 1, bbox: [100, 100 + index * 50, 900, 140 + index * 50] })),
];

export function resultFiles(): Record<string, Uint8Array> {
  return {
    'auto/paper_content_list.json': encoder.encode(JSON.stringify(CONTENT_LIST)),
    'full.md': encoder.encode('# A Study of Things'),
    'paper_origin.pdf': encoder.encode('%PDF-origin'),
  };
}

function fakePdf(pages: number): PdfDocument {
  return {
    numPages: pages,
    getPage: async () => ({
      getTextContent: async () => ({ items: [] }),
      getViewport: () => ({ width: 600, height: 800, scale: 1, convertToViewportPoint: (x: number, y: number) => [x, y] }),
      render: () => ({ promise: Promise.resolve() }),
      cleanup: () => undefined,
    }),
    destroy: async () => undefined,
  };
}

const cropper: Cropper = {
  cropPage: async (_page: number, requests: CropRequest[]) => new Map(requests.map(request => [request.blockId, { png: new Uint8Array([137, 80, 78, 71]), width: 10, height: 10 } satisfies CropResult])),
};

/** Scriptable MinerU: every call is counted so tests can assert "uploaded exactly once". */
export class FakeMinerU implements MinerUClient {
  requests = 0;
  uploads = 0;
  polls = 0;
  downloads = 0;
  nextBatch = 1;
  requestFailures: Error[] = [];
  uploadFailures: Error[] = [];
  pollScript: Array<MinerUPoll | Error> = [];
  pollDefault: MinerUPoll = { state: 'done', zipUrl: 'https://cdn.example/result.zip' };
  uploadGate?: Promise<void>;
  acceptedUploadFailures: Error[] = [];
  uploadUrls: string[] = [];
  files: () => Record<string, Uint8Array> = resultFiles;

  async requestUpload(): Promise<{ batchId: string; uploadUrl: string }> {
    this.requests++;
    const failure = this.requestFailures.shift();
    if (failure) throw failure;
    return { batchId: `batch-${this.nextBatch++}`, uploadUrl: 'https://upload.example/put' };
  }

  async upload(url: string): Promise<void> {
    this.uploadUrls.push(url);
    const failure = this.uploadFailures.shift();
    if (failure) throw failure;
    this.uploads++;
    await this.uploadGate;
    const acceptedFailure = this.acceptedUploadFailures.shift();
    if (acceptedFailure) throw acceptedFailure;
  }

  async poll(): Promise<MinerUPoll> {
    this.polls++;
    const next = this.pollScript.shift() ?? this.pollDefault;
    if (next instanceof Error) throw next;
    return next;
  }

  async download(): Promise<Record<string, Uint8Array>> {
    this.downloads++;
    return this.files();
  }
}

export class FakeQwen implements QwenMtClient {
  calls: string[] = [];
  /** Return a value to translate, throw to fail; default is a deterministic translation. */
  behaviour: (request: TranslateRequest, call: number) => Promise<string> | string = request => `译：${request.text}`;
  gate?: Promise<void>;

  async translate(request: TranslateRequest): Promise<string> {
    this.calls.push(request.text);
    await this.gate;
    if (request.signal?.aborted) throw new Error('aborted');
    return this.behaviour(request, this.calls.length);
  }
}

export const silentLog: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface Fixture {
  base: string;
  store: FileStore;
  events: EventBus;
  emitted: Array<{ name: EventName; payload: unknown }>;
  mineru: FakeMinerU;
  qwen: FakeQwen;
  vault: Map<string, Uint8Array>;
  approved: { all: boolean };
  glossary: Term[];
  create(overrides?: Partial<PipelineDeps>): Pipeline;
  paperDir(sha: string): string;
}

/** A store in a temp dir, an in-memory vault, and fake services. `create()` makes a fresh pipeline over the same disk state. */
export async function pipelineFixture(): Promise<Fixture> {
  const base = await tempDir('pw-pipeline-');
  const vault = new Map<string, Uint8Array>();
  const read = async (vaultPath: string) => {
    const bytes = vault.get(vaultPath);
    if (!bytes) throw Object.assign(new Error(`ENOENT: ${vaultPath}`), { code: 'ENOENT' });
    return bytes;
  };
  const store = new FileStore({ basePath: base, resourcePath: relative => `app://local/${relative}`, readVaultFile: async vaultPath => (await read(vaultPath)).slice().buffer });
  const events = new EventBus();
  const emitted: Fixture['emitted'] = [];
  const names: EventName[] = ['paper:stage-changed', 'paper:parse-progress', 'paper:translation-progress', 'paper:document-updated', 'paper:conflict', 'paper:path-changed', 'pipeline:paused'];
  for (const name of names) events.on(name, (payload: EventMap[typeof name]) => emitted.push({ name, payload }));
  const mineru = new FakeMinerU();
  const qwen = new FakeQwen();
  const approved = { all: true };
  const glossary: Term[] = [];
  const fixture: Fixture = {
    base, store, events, emitted, mineru, qwen, vault, approved, glossary,
    create: overrides => new Pipeline({
      store, events, mineru, qwenMt: qwen,
      glossary: () => fixture.glossary,
      readPdf: read,
      openPdf: async () => fakePdf(2),
      createCropper: () => cropper,
      isApproved: (_manifest: Manifest) => approved.all,
      isInLibrary: vaultPath => vaultPath.startsWith('sources/literature/pdf/'),
      log: silentLog,
      sleep: async (_ms, signal) => { if (signal?.aborted) throw new Error('aborted'); await new Promise(resolve => setTimeout(resolve, 0)); },
      retryDelays: [0, 0, 0],
      pollIntervalMs: 0,
      ...overrides,
    }),
    paperDir: sha => path.join(base, '.research', 'papers', sha),
  };
  return fixture;
}

export async function addPdf(fixture: Fixture, vaultPath: string, content: string): Promise<string> {
  const bytes = encoder.encode(`%PDF-1.7 ${content}`);
  fixture.vault.set(vaultPath, bytes);
  return sha256Bytes(bytes);
}

export async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

export function retryableNetworkError(): MinerUError {
  return new MinerUError('MinerU 请求失败，HTTP 503。', true, 503);
}

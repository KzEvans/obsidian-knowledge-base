import { unzipSync } from 'fflate';
import type { Http } from './http';

/** MinerU cloud precision API, VLM model (decision 2). Scheduling lives in library; this is HTTP only. */
export const MINERU_API = 'https://mineru.net/api/v4';
export const MINERU_OPTIONS = { model_version: 'vlm', enable_formula: true, enable_table: true, language: 'en' } as const;
export const MAX_PDF_BYTES = 200 * 1024 * 1024;
export const MAX_PDF_PAGES = 200;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

export type MinerUState = 'pending' | 'running' | 'converting' | 'done' | 'failed';

export interface MinerUPoll {
  state: MinerUState;
  zipUrl?: string;
  progress?: { done: number; total: number };
  error?: string;
}

export class MinerUError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = 'MinerUError';
  }
}

export interface MinerUClient {
  requestUpload(sha: string): Promise<{ batchId: string; uploadUrl: string }>;
  upload(uploadUrl: string, pdf: ArrayBuffer): Promise<void>;
  poll(batchId: string): Promise<MinerUPoll>;
  /** Every member of the result archive, after path and size checks. */
  download(zipUrl: string): Promise<Record<string, Uint8Array>>;
}

interface ApiEnvelope { code?: unknown; msg?: unknown; data?: unknown }

export function createMinerUClient(http: Http, token: () => string | null): MinerUClient {
  async function api(endpoint: string, method: 'GET' | 'POST', body?: object): Promise<Record<string, unknown>> {
    const secret = token();
    if (!secret) throw new MinerUError('MinerU Token 未配置，请在设置中保存。', false);
    const response = await http({
      url: MINERU_API + endpoint, method,
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 401 || response.status === 403) throw new MinerUError('MinerU Token 无效或已过期，请在设置中更新。', false, response.status);
    if (response.status === 429) throw new MinerUError('MinerU 请求受限，稍后重试。', true, 429);
    if (response.status >= 400) throw new MinerUError(`MinerU 请求失败，HTTP ${response.status}。`, response.status >= 500, response.status);
    const envelope = response.json as ApiEnvelope | undefined;
    if (envelope?.code !== 0) throw new MinerUError(`MinerU 返回错误，代码 ${typeof envelope?.code === 'number' || typeof envelope?.code === 'string' ? envelope.code : '未知'}。`, false, response.status);
    return isRecord(envelope.data) ? envelope.data : {};
  }

  return {
    async requestUpload(sha) {
      const data = await api('/file-urls/batch', 'POST', {
        files: [{ name: 'paper.pdf', data_id: 'pw_' + sha.slice(0, 24) }],
        ...MINERU_OPTIONS,
      });
      const uploadUrl: unknown = Array.isArray(data.file_urls) ? (data.file_urls as unknown[])[0] : undefined;
      if (typeof data.batch_id !== 'string' || typeof uploadUrl !== 'string' || !uploadUrl.startsWith('https://')) {
        throw new MinerUError('MinerU 没有返回有效的上传地址。', true);
      }
      return { batchId: data.batch_id, uploadUrl };
    },

    async upload(uploadUrl, pdf) {
      if (pdf.byteLength > MAX_PDF_BYTES) throw new MinerUError('MinerU 云端最大支持 200 MB 的文件。', false);
      // The pre-signed URL carries its own credential; no Authorization header.
      const response = await http({ url: uploadUrl, method: 'PUT', body: pdf });
      if (response.status < 200 || response.status >= 300) throw new MinerUError(`PDF 上传失败，HTTP ${response.status}。`, true, response.status);
    },

    async poll(batchId) {
      const data = await api('/extract-results/batch/' + encodeURIComponent(batchId), 'GET');
      const result = Array.isArray(data.extract_result) && isRecord(data.extract_result[0]) ? data.extract_result[0] : undefined;
      if (!result) throw new MinerUError('MinerU 未返回任务状态。', true);
      const state = result.state;
      if (state === 'failed') return { state, error: typeof result.err_msg === 'string' ? result.err_msg.slice(0, 300) : undefined };
      if (state === 'done') {
        if (typeof result.full_zip_url !== 'string' || !result.full_zip_url.startsWith('https://')) throw new MinerUError('MinerU 未返回有效的结果地址。', true);
        return { state, zipUrl: result.full_zip_url };
      }
      const progress = isRecord(result.extract_progress) ? result.extract_progress : undefined;
      const done = Number(progress?.extracted_pages), total = Number(progress?.total_pages);
      return {
        state: state === 'running' || state === 'converting' ? state : 'pending',
        progress: Number.isFinite(done) && Number.isFinite(total) && total > 0 ? { done, total } : undefined,
      };
    },

    async download(zipUrl) {
      const response = await http({ url: zipUrl, method: 'GET' });
      if (response.status !== 200) throw new MinerUError(`解析结果下载失败，HTTP ${response.status}。`, true, response.status);
      return unpackArchive(new Uint8Array(response.arrayBuffer));
    },
  };
}

/** Unzip with traversal and size guards. Keeps every member: raw/ is the provider's complete result. */
export function unpackArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  let oversized = '';
  const entries = unzipSync(bytes, {
    filter: entry => {
      if (entry.originalSize > MAX_ENTRY_BYTES) oversized ||= entry.name;
      return entry.originalSize <= MAX_ENTRY_BYTES;
    },
  });
  if (oversized) throw new MinerUError(`解析结果中的文件过大：${oversized.slice(0, 120)}`, false);
  let total = 0;
  const files: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue;
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || /^[A-Za-z]:/.test(name)) {
      throw new MinerUError('解析结果包含非法路径。', false);
    }
    total += data.byteLength;
    files[name] = data;
  }
  if (total > MAX_ARCHIVE_BYTES) throw new MinerUError('解析结果过大。', false);
  if (contentListName(Object.keys(files)) === undefined) throw new MinerUError('MinerU 未返回兼容的结构化内容列表（content_list.json）。', false);
  return files;
}

/** The single `*_content_list.json` (cloud Content List V1) in a result. v2 is not the normalizer's contract. */
export function contentListName(names: string[]): string | undefined {
  const lists = names.filter(name => /(?:^|\/)(?:.*_)?content_list\.json$/.test(name));
  return lists.length === 1 ? lists[0] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

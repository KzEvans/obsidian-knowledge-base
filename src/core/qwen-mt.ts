import { sha256Text } from './hash';
import { raceWithTimeout } from './http';
import type { Http } from './http';
import type { Term } from './types';

/** Alibaba Cloud Model Studio (DashScope), OpenAI-compatible endpoint. */
export const DEFAULT_QWEN_MT_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
export const FULL_TEXT_MODEL = 'qwen-mt-plus';
export const SELECTION_MODEL = 'qwen-mt-flash';

export class QwenMtError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = 'QwenMtError';
  }
}

/** The model changed, dropped or duplicated a protected span. Retry; never store the result. */
export class PlaceholderMismatchError extends Error {
  constructor() {
    super('译文中的公式或上下标占位符不完整。');
    this.name = 'PlaceholderMismatchError';
  }
}

export interface TranslateRequest {
  text: string;
  model: string;
  terms: readonly Term[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface QwenMtClient {
  translate(request: TranslateRequest): Promise<string>;
}

export function createQwenMtClient(http: Http, apiKey: () => string | null, endpoint: () => string): QwenMtClient {
  return {
    async translate(request) {
      const key = apiKey();
      if (!key) throw new QwenMtError('请先在设置中保存阿里云百炼 API Key。', false);
      const source = request.text.trim();
      if (!source) throw new QwenMtError('没有可翻译的文本。', false);
      const { text: masked, spans } = protectSpans(source);
      const terms = termsFor(source, request.terms);
      const response = await raceWithTimeout(http({
        url: normalizeEndpoint(endpoint()),
        method: 'POST',
        contentType: 'application/json',
        headers: { Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: request.model,
          messages: [{ role: 'user', content: masked }],
          translation_options: { source_lang: 'auto', target_lang: 'Chinese', ...(terms.length ? { terms } : {}) },
        }),
      }), request.timeoutMs, request.signal, `Qwen-MT 在 ${Math.round(request.timeoutMs / 1000)} 秒内没有返回。`);

      if (response.status === 401 || response.status === 403) throw new QwenMtError('阿里云百炼 API Key 无效、已过期或没有 Qwen-MT 权限。', false, response.status);
      if (response.status === 429) throw new QwenMtError('Qwen-MT 请求过于频繁或额度不足，稍后重试。', true, 429);
      if (response.status < 200 || response.status >= 300) {
        throw new QwenMtError(`Qwen-MT 请求失败（${response.status}）${apiDetail(response.json)}`, response.status >= 500, response.status);
      }
      const content = completionText(response.json);
      if (!content) throw new QwenMtError('Qwen-MT 没有返回译文。', true);
      return restoreSpans(content, spans);
    },
  };
}

// ---- Placeholder protection (architecture §3.3) ----

/** `⟦n⟧` survives machine translation untouched far more often than ASCII brackets or tags. */
const PLACEHOLDER = /⟦(\d+)⟧/g;
const PROTECTED = /(?<!\\)\$\$[\s\S]+?(?<!\\)\$\$|(?<!\\)\$[^$\n]+?(?<!\\)\$|<sup\b[^>]*>[\s\S]*?<\/sup>|<sub\b[^>]*>[\s\S]*?<\/sub>/gi;

export function protectSpans(text: string): { text: string; spans: string[] } {
  const spans: string[] = [];
  // A literal ⟦n⟧ in the source would be ambiguous; protect it too.
  const masked = text.replace(new RegExp(`${PROTECTED.source}|⟦\\d+⟧`, 'gi'), match => {
    spans.push(match);
    return `⟦${spans.length}⟧`;
  });
  return { text: masked, spans };
}

/** Every placeholder must come back exactly once; anything else is a corrupt translation. */
export function restoreSpans(translated: string, spans: readonly string[]): string {
  const seen = new Set<number>();
  for (const match of translated.matchAll(PLACEHOLDER)) {
    const index = Number(match[1]);
    if (index < 1 || index > spans.length || seen.has(index)) throw new PlaceholderMismatchError();
    seen.add(index);
  }
  if (seen.size !== spans.length) throw new PlaceholderMismatchError();
  return translated.replace(PLACEHOLDER, (_, index: string) => spans[Number(index) - 1]!);
}

// ---- Glossary ----

/** Only terms that occur in this text are sent, matched case-insensitively on word boundaries. */
export function termsFor(text: string, terms: readonly Term[]): Term[] {
  const seen = new Set<string>();
  return terms.filter(term => {
    const source = term.source.trim();
    if (!source || !term.target.trim() || seen.has(source.toLowerCase())) return false;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(source)}(?![\\p{L}\\p{N}])`, 'iu');
    if (!pattern.test(text)) return false;
    seen.add(source.toLowerCase());
    return true;
  }).map(term => ({ source: term.source.trim(), target: term.target.trim() }));
}

/** Identifies the glossary entries that shaped a translation; a change means re-translate (contracts §4). */
export function termsKey(text: string, terms: readonly Term[]): string {
  const used = termsFor(text, terms).map(term => [term.source.toLowerCase(), term.target]).sort();
  return sha256Text(JSON.stringify(used));
}

// ---- helpers ----

function normalizeEndpoint(value: string): string {
  const endpoint = (value.trim() || DEFAULT_QWEN_MT_ENDPOINT).replace(/\/+$/, '');
  if (!/^https:\/\//i.test(endpoint)) throw new QwenMtError('Qwen-MT 接口地址必须使用 https。', false);
  if (/\/chat\/completions$/i.test(endpoint)) return endpoint;
  if (/\/compatible-mode\/v1$/i.test(endpoint)) return `${endpoint}/chat/completions`;
  throw new QwenMtError('接口地址必须以 /compatible-mode/v1 或 /chat/completions 结尾。', false);
}

function completionText(json: unknown): string | undefined {
  const choices = (json as { choices?: Array<{ message?: { content?: unknown } }> } | undefined)?.choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === 'string' && content.trim() ? content.trim() : undefined;
}

function apiDetail(json: unknown): string {
  const payload = json as { error?: { message?: unknown }; message?: unknown } | undefined;
  const detail = payload?.error?.message ?? payload?.message;
  return typeof detail === 'string' && detail ? `：${detail.slice(0, 300)}` : '。';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

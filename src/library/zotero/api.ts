import { fileURLToPath } from 'node:url';
import type { Http } from '../../core/http';
import type { ZoteroCollection, ZoteroItem } from './naming';

export const DEFAULT_ZOTERO_API = 'http://localhost:23119/api';
const PAGE = 100;

/** Zotero is closed or "Allow other applications to communicate with Zotero" is off. */
export class ZoteroUnavailableError extends Error {
  constructor(detail: string) {
    super(`Zotero 没有运行或未开启本地 API（${detail}），下一轮自动重试。`);
    this.name = 'ZoteroUnavailableError';
  }
}

export interface ZoteroApi {
  collections(): Promise<ZoteroCollection[]>;
  collectionItems(collectionKey: string): Promise<ZoteroItem[]>;
  /** Absolute local path of an attachment file. */
  attachmentPath(attachmentKey: string): Promise<string>;
  /** BibTeX for up to 50 parent items. */
  bibtex(itemKeys: readonly string[]): Promise<string>;
}

/** The Zotero 7 local API (connector port 23119) through Obsidian's requestUrl. */
export function createZoteroApi(http: Http, apiBase: () => string): ZoteroApi {
  async function get(path: string, accept = 'application/json'): Promise<{ text: string; json: unknown }> {
    const url = `${apiBase().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
    let response;
    try {
      response = await http({ url, method: 'GET', headers: { Accept: accept, 'Zotero-API-Version': '3' } });
    } catch (error) {
      throw new ZoteroUnavailableError(error instanceof Error ? error.message.slice(0, 120) : String(error));
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Zotero 本地 API 返回 HTTP ${response.status}：${path.split('?')[0]}`);
    return { text: response.text, json: response.json };
  }

  async function list<T>(path: string): Promise<T[]> {
    const result: T[] = [];
    for (;;) {
      const { json } = await get(`${path}${path.includes('?') ? '&' : '?'}limit=${PAGE}&start=${result.length}`);
      if (!Array.isArray(json)) throw new Error('Zotero 本地 API 返回的不是列表。');
      result.push(...(json as T[]));
      if (json.length < PAGE) return result;
    }
  }

  return {
    collections: () => list<ZoteroCollection>('users/0/collections?format=json'),
    collectionItems: key => list<ZoteroItem>(`users/0/collections/${encodeURIComponent(key)}/items?format=json&include=data`),
    async attachmentPath(key) {
      const { text } = await get(`users/0/items/${encodeURIComponent(key)}/file/view/url`, 'text/plain');
      const value = text.trim();
      if (!value.startsWith('file:')) throw new Error(`附件 ${key} 不是本地文件。`);
      return fileURLToPath(value);
    },
    async bibtex(keys) {
      const { text } = await get(`users/0/items?itemKey=${keys.join(',')}&format=bibtex&limit=100`, 'application/x-bibtex');
      return text;
    },
  };
}

/** Prefer the configured key when its name still matches; otherwise the single collection with that name. */
export function resolveCollection(collections: readonly ZoteroCollection[], name: string, key: string): string {
  if (collections.some(collection => collection.key === key && collection.data?.name === name)) return key;
  const matches = collections.filter(collection => collection.data?.name === name && collection.key).map(collection => collection.key);
  if (matches.length !== 1) throw new Error(`Zotero 中名为“${name}”的分类应当正好有一个，实际找到 ${matches.length} 个。`);
  return matches[0]!;
}

/** Items of the root collection and every descendant, deduplicated by key. */
export async function collectionItems(api: ZoteroApi, paths: Record<string, string>): Promise<ZoteroItem[]> {
  const items = new Map<string, ZoteroItem>();
  for (const key of Object.keys(paths)) for (const item of await api.collectionItems(key)) items.set(item.key, item);
  return [...items.values()];
}

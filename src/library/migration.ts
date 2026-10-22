import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256Bytes } from '../core/hash';
import { MINERU_OPTIONS, contentListName } from '../core/mineru';
import { errorMessage } from '../core/secrets';
import { atomicWrite } from '../core/store';
import type { StoreWriter } from '../core/store';
import type { Manifest } from '../core/types';

/** One-time import of the old reader cache and Zotero sync state (docs/migration.md §2). Old files are only read. */

const CACHE_DIR = /^([0-9a-f]{64})-vlm-v1$/;
/** The members the old plugin kept; its crops, result.json and performance.json are not imported. */
const IMPORTED_MEMBER = /^(?:[^/]*_content_list\.json|[^/]*_content_list_v2\.json|[^/]*_model\.json|layout\.json|full\.md|images\/.+)$/;

export interface CacheImportResult {
  imported: string[];
  /** Papers whose old cache had only job.json; their batch is resumed first. */
  resumed: string[];
  skipped: string[];
  errors: string[];
}

/**
 * `cacheRoot` is `<vault>/<configDir>/plugins/pdf-reading-mode/cache`. Each `<sha>-vlm-v1/` with a
 * content list becomes raw/ + IMPORTED.json; one with only job.json carries its batchId over.
 */
export async function importReaderCache(cacheRoot: string, store: StoreWriter, now: () => Date = () => new Date(), log: (message: string) => void = () => undefined): Promise<CacheImportResult> {
  const result: CacheImportResult = { imported: [], resumed: [], skipped: [], errors: [] };
  let directories: string[];
  try { directories = (await fs.readdir(cacheRoot)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }

  for (const directory of directories) {
    const sha = CACHE_DIR.exec(directory)?.[1];
    if (!sha) continue;
    try {
      const existing = await store.manifest(sha);
      if (existing && (existing.raw || existing.mineru?.batchId || existing.stage !== 'copied')) { result.skipped.push(sha); continue; }
      const root = path.join(cacheRoot, directory);
      // Reading each file makes iCloud download it if it was evicted.
      const names = (await fs.readdir(root, { recursive: true })).map(name => name.split(path.sep).join('/'));
      const members = names.filter(name => IMPORTED_MEMBER.test(name));
      const files: Record<string, Uint8Array> = {};
      for (const name of members) {
        const stat = await fs.stat(path.join(root, name));
        if (stat.isFile()) files[name] = new Uint8Array(await fs.readFile(path.join(root, name)));
      }
      const at = now().toISOString();
      if (contentListName(Object.keys(files))) {
        const imported = {
          origin: 'imported-reader-cache',
          sourceDirectory: `pdf-reading-mode/cache/${directory}`,
          importedAt: at,
          note: '旧阅读模式只保存了 json、md 和图片；结果包中的 PDF 原件和其他格式的成员缺失。旧裁图、result.json、performance.json 未导入，裁图在规范化时重新生成。',
          members: Object.keys(files).sort(),
          missing: ['MinerU 结果包中的原始 PDF（*_origin.pdf）', '其他非 json/md/图片 成员'],
        };
        files['IMPORTED.json'] = new TextEncoder().encode(JSON.stringify(imported, null, 2) + '\n');
        await store.writeRaw(sha, files);
        const hashes: Record<string, string> = {};
        for (const [name, bytes] of Object.entries(files)) hashes[name] = await sha256Bytes(bytes);
        await store.writeManifest(sha, {
          ...(existing ?? baseManifest(sha, at)),
          stage: 'normalizing',
          mineru: { modelVersion: 'vlm', options: options(), origin: 'imported-reader-cache' },
          raw: { files: hashes, complete: false },
          updatedAt: at,
        });
        result.imported.push(sha);
        log(`已导入旧阅读缓存：${sha.slice(0, 12)}（${members.length} 个文件）`);
        continue;
      }
      const job = await readJson(path.join(root, 'job.json')) as { batchId?: unknown; uploaded?: unknown } | undefined;
      if (typeof job?.batchId === 'string' && job.batchId && job.uploaded === true) {
        await store.writeManifest(sha, {
          ...(existing ?? baseManifest(sha, at)),
          stage: 'parsing',
          mineru: { batchId: job.batchId, modelVersion: 'vlm', options: options(), origin: 'imported-reader-cache' },
          updatedAt: at,
        });
        result.resumed.push(sha);
        log(`旧阅读缓存只有任务记录，将先续取：${sha.slice(0, 12)}`);
        continue;
      }
      result.skipped.push(sha);
    } catch (error) {
      // Usually iCloud still downloading: try again next time instead of giving up.
      result.errors.push(`${sha.slice(0, 12)}：${errorMessage(error)}`);
    }
  }
  return result;
}

function baseManifest(sha: string, at: string): Manifest {
  return { schemaVersion: 1, sha256: sha, sources: [], stage: 'copied', failure: null, priority: false, updatedAt: at };
}

function options() {
  return { enable_formula: MINERU_OPTIONS.enable_formula, enable_table: MINERU_OPTIONS.enable_table, language: MINERU_OPTIONS.language };
}

export async function readJson(file: string): Promise<unknown> {
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  return JSON.parse(text) as unknown;
}

/** The parts of `system/zotero-sync/config.json` that become library settings. */
export interface LegacyZoteroConfig {
  api_base?: unknown;
  collection_key?: unknown;
  collection_name?: unknown;
  automatic_impact_factor?: Record<string, unknown>;
  impact_factors?: unknown;
  supplementary_information?: Record<string, unknown>;
}

/** Copy the Python sync's state files into the plugin folder once, so the next sync copies nothing twice. */
export async function importLegacyState(legacyDir: string, pluginDir: string, names: readonly string[]): Promise<string[]> {
  const copied: string[] = [];
  for (const name of names) {
    const target = path.join(pluginDir, name);
    try { await fs.access(target); continue; } catch { /* not imported yet */ }
    const source = path.join(legacyDir, name);
    try { await fs.access(source); } catch { continue; }
    const text = await fs.readFile(source, 'utf8');
    JSON.parse(text);
    await atomicWrite(target, Buffer.from(text, 'utf8'));
    copied.push(name);
  }
  return copied;
}

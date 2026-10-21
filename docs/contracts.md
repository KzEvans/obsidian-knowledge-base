# 数据契约

本文是各会话共同遵守的接口。阶段 1 结束时冻结；之后修改要向主会话提出，由主会话统一调整。TypeScript 定义以 `src/core/` 中的代码为准，本文给出语义。

## 1. 存储目录

```
<vault>/.research/
  index.json                    vault 路径 → sha256，library 维护
  conflicts/<时间戳>/            你确认处理冲突后，被替下的文件移到这里
  papers/<sha256>/
    manifest.json
    raw/                        MinerU 原始文件，写一次后不再修改
      IMPORTED.json             仅从旧缓存导入时存在，说明来源和缺失的成员
      <MinerU 结果包里的全部成员，保持原相对路径>
    derived/                    可由 raw/ + 原 PDF 重建
      source-tables-v1/<blockId>.png
      fallback-v2/<blockId>.png
    document.json
    translation.zh.json
```

- 路径中的 `<sha256>` 是 PDF 字节的小写十六进制 SHA-256。
- 所有 JSON 用 UTF-8、2 空格缩进，以换行结尾。
- 写入方式：写 `<name>.tmp-<随机>` → `fsync` → `rename`。读到 `.tmp-` 残留文件时忽略并清理。
- 新解析的论文，`raw/` 保存结果包的**全部**成员（旧插件只保留了 json、md 和图片）。

## 2. `manifest.json`

```jsonc
{
  "schemaVersion": 1,
  "sha256": "770be368…",
  "pageCount": 12,
  "sources": [                                   // 同一份 PDF 可能出现在多处
    { "path": "sources/literature/pdf/自适应聚合物网络/Chen 等 - 2021 - … (3Y45NZ44).pdf",
      "zoteroAttachmentKey": "3Y45NZ44", "zoteroParentKey": "…", "inLibrary": true }
  ],
  "stage": "ready",          // discovered | copied | uploading | parsing | normalizing | translating | ready | failed | conflict
  "failure": null,           // { "stage": "parsing", "error": "已脱敏的信息", "attempts": 3, "at": "ISO", "retryable": true }
  "priority": false,
  "mineru": {
    "batchId": "…",          // 上传成功后立即写入；有值就只续取不重传
    "modelVersion": "vlm",
    "options": { "enable_formula": true, "enable_table": true, "language": "en" },
    "uploadedAt": "ISO",
    "completedAt": "ISO",
    "origin": "cloud"        // cloud | imported-reader-cache
  },
  "raw": { "files": { "relative/path": "sha256" }, "complete": true },
  "normalized": { "normalizerVersion": 12, "at": "ISO" },
  "translation": { "model": "qwen-mt-plus", "total": 184, "done": 184, "failed": 0, "at": "ISO" },
  "updatedAt": "ISO"
}
```

- `raw.files` 记录 `raw/` 中每个文件的哈希，读取时可校验没被改动。
- `raw.complete: false` 表示从旧缓存导入，结果包的部分成员缺失（例如 PDF 原件、未知格式文件）。规范化只用到 content_list 和图片，不受影响。
- `failure.error` 已经过脱敏，不含 Token、Key、带签名的 URL。

## 3. `document.json`

在现有 `ReaderDocument` 基础上增加字段：

```ts
interface StoredDocument {
  schemaVersion: 2;
  sha256: string;
  normalizerVersion: number;
  pageCount: number;
  blocks: StoredBlock[];
  warnings: string[];
  assets: Record<string, { path: string; width?: number; height?: number }>;  // key 为块里的 asset 引用
}

interface StoredBlock extends ReaderBlock {     // ReaderBlock 字段不变：id、kind、sources、html、text、level、asset、captions、footnotes、hiddenByDefault
  role?: "abstract";                            // 摘要块
  translatable: boolean;                        // 见下
  segments?: Segment[];                         // 可翻译块的翻译单元
}

interface Segment {
  field: "text" | "caption" | "footnote";
  index: number;                                // captions/footnotes 数组下标；text 为 0
  sourceHash: string;                           // sha256(规范化后的源文本)，译文按它存取
}
```

- `asset` 的 `path` 相对于论文存储目录，例如 `raw/images/abc.jpg`、`derived/source-tables-v1/block-17.png`。
- **可翻译：** `kind` 为 `paragraph`、`heading`、`list`、`footnote`，以及 `figure`、`table`、`equation` 的题注和脚注。`references`、`metadata`、`header`、`footer` 和公式本体不翻译。
- `sourceHash` 的输入：去掉首尾空白、连续空白合并为一个空格后的源文本（保留 `$…$` 和 `<sup>/<sub>` 原样）。

## 4. `translation.zh.json`

```jsonc
{
  "schemaVersion": 1,
  "entries": {
    "<sourceHash>": {
      "text": "译文（占位符已还原）",
      "model": "qwen-mt-plus",
      "termsKey": "sha256(本段命中的术语对，排序后)",
      "at": "ISO"
    }
  },
  "failures": {
    "<sourceHash>": { "error": "PlaceholderMismatch", "attempts": 3, "at": "ISO" }
  }
}
```

- 按 `sourceHash` 存，不按 block id。规范化升级后文本没变的段落直接复用译文。
- 术语表修改后，只重译 `termsKey` 变化了的段落。
- 不在当前 `document.json` 中的条目保留不删（旧版本可能还会用到），文件过大时再考虑清理。

## 5. core 接口

```ts
// store.ts
interface StoreReader {
  shaForPath(vaultPath: string): Promise<string | undefined>;   // 先查 index.json，查不到再算哈希
  manifest(sha: string): Promise<Manifest | undefined>;
  document(sha: string): Promise<StoredDocument | undefined>;
  translations(sha: string): Promise<TranslationFile | undefined>;
  assetUrl(sha: string, assetPath: string): string;             // app.vault.adapter.getResourcePath
  conflicts(sha: string): Promise<string[]>;                     // iCloud 冲突副本文件名
}
interface StoreWriter extends StoreReader {
  writeManifest(sha: string, manifest: Manifest): Promise<void>;
  writeRaw(sha: string, files: Record<string, Uint8Array>): Promise<void>;   // 目标已存在则抛错
  writeDerived(sha: string, relativePath: string, bytes: Uint8Array): Promise<void>;
  writeDocument(sha: string, doc: StoredDocument): Promise<void>;
  writeTranslations(sha: string, file: TranslationFile): Promise<void>;
  setPath(vaultPath: string, sha: string | null): Promise<void>;
}

// derive.ts
function derive(input: { sha: string; raw: RawFiles; pdf: PdfDocumentProxy; previous?: StoredDocument }): Promise<{ document: StoredDocument; derived: Record<string, Uint8Array> }>;
const NORMALIZER_VERSION: number;

// mineru.ts
interface MinerUClient {
  requestUpload(sha: string): Promise<{ batchId: string; uploadUrl: string }>;
  upload(uploadUrl: string, pdf: ArrayBuffer): Promise<void>;
  poll(batchId: string): Promise<{ state: "pending" | "running" | "converting" | "done" | "failed"; zipUrl?: string; progress?: { done: number; total: number } }>;
  download(zipUrl: string): Promise<Record<string, Uint8Array>>;   // 已做路径安全和大小检查
}

// qwen-mt.ts
interface TranslateRequest { text: string; model: string; terms: Term[]; timeoutMs: number; signal?: AbortSignal }
function translate(request: TranslateRequest): Promise<string>;   // 失败抛 QwenMtError | PlaceholderMismatchError
interface Term { source: string; target: string }

// queue.ts
interface TaskQueue {
  enqueue<T>(key: string, run: (signal: AbortSignal) => Promise<T>, options?: { priority?: boolean }): Promise<T>;
  cancel(key: string): void;
  pause(): void; resume(): void;
  readonly paused: boolean;
}

// services.ts
interface PipelineControl {
  status(sha: string): Promise<Manifest | undefined>;
  requestParse(vaultPath: string): Promise<void>;    // 文献库外 PDF，调用前由 reader 征得你同意
  prioritize(sha: string): void;
  retry(sha: string): void;
  cancel(sha: string): void;
}
interface AgentRunner {                                // 影响因子自动查询
  runReadOnly(prompt: string, options: { timeoutMs: number; signal?: AbortSignal; outputSchema?: object }): Promise<string>;
}
interface PdfToolbar {
  register(button: { id: string; order: number; icon: string; label: string; onClick(leaf: WorkspaceLeaf): void; isActive?(leaf: WorkspaceLeaf): boolean }): () => void;
}
interface Services {
  pipeline?: PipelineControl;
  agent?: AgentRunner;
  pdfToolbar: PdfToolbar;
}

// 模块入口
interface ModuleContext<S> {
  plugin: Plugin;
  events: EventBus;
  services: Services;
  store: StoreReader;            // library 额外拿到 StoreWriter
  settings: S;
  saveSettings(): Promise<void>;
  secrets: SecretAccess;
  log: Logger;                   // 自动脱敏
}
```

## 6. 事件总线

| 事件 | 载荷 | 发出方 | 订阅方 |
|---|---|---|---|
| `paper:stage-changed` | `{ sha, stage, failure? }` | library | reader、agent、状态栏 |
| `paper:parse-progress` | `{ sha, done, total }`（MinerU 页数） | library | reader |
| `paper:translation-progress` | `{ sha, done, total, failed }` | library | reader |
| `paper:document-updated` | `{ sha, normalizerVersion }` | library | reader（重新渲染） |
| `paper:conflict` | `{ sha, files }` | library | reader、状态栏 |
| `paper:path-changed` | `{ sha, oldPath, newPath }` | library | reader（阅读位置）、agent（会话） |
| `pipeline:paused` | `{ paused }` | library | 状态栏 |
| `zotero:sync-finished` | `{ ok, copied, failed, error? }` | library | 状态栏 |
| `reader:mode-change` | `{ leafId, active, language }` | reader | selection |
| `note:generated` | `{ notePath, sha, conflict }` | agent | — |

事件只是通知，订阅方收到后应从存储重新读取，不依赖载荷里的状态。

## 7. 笔记文件

- 位置：`wiki/papers/<collection-path>/<YYYY-MM-DD - 第一作者 - 标题>.md`。
- frontmatter 字段见 `feature-inventory.md` 第 6 节。
- 受保护区域（重新生成时原样保留）：
  - 标题为 `人工复核`、`Human Review`、`提问` 的节，到下一个同级或更高级标题为止；
  - `<!-- user-notes:start -->…<!-- user-notes:end -->`；
  - `<!-- intensive-reading:<id>:start -->…<!-- intensive-reading:<id>:end -->`。
- 模板与写作规则见 `skills/paper-note/SKILL.md`（阶段 2 产出）。

## 8. 密钥

| 用途 | SecretStorage id |
|---|---|
| MinerU Token | `paper-workbench-mineru-token` |
| DashScope API Key | `paper-workbench-dashscope-key` |

日志、错误信息、manifest 中出现的字符串都经过 `redact()`：替换已知密钥的值、`Bearer …`、`sk-…` 形式的串，以及 URL 中的签名查询参数。

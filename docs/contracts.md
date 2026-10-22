# 数据契约

本文是各会话共同遵守的接口。阶段 1 结束时冻结；之后修改要向主会话提出，由主会话统一调整。TypeScript 定义以 `src/core/` 中的代码为准，本文给出语义。

## 1. 存储目录

```
<vault>/.research/
  index.json                    vault 路径 → sha256，library 维护
  conflicts/<时间戳>/            你确认处理冲突后，被替下的文件移到这里
  papers/<sha256>/
    manifest.json
    uploads/<batchId-sha256>.json  PUT 前持久化的不可变上传记录（仅 library 可读写）
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
    "batchId": "…",          // 申请地址后、PUT 前写入；重启先 poll，仅 waiting-file 才复用原地址 PUT
    "previousBatchIds": [],   // 已失效或冲突选择中未采用的 batch 留痕，不静默丢弃
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

- `uploads/` 中每条记录为 `{ batchId, uploadUrl, createdAt }`，先 fsync 再 link 写一次，独立于 manifest 冲突。签名 URL 只用于恢复 PUT，不放入 manifest、日志、事件或智能体输入；MinerU Token / DashScope Key 仍只在 SecretStorage。重启或 PUT 报错后先 poll 同一 batch；仅 `waiting-file` 可复用原地址 PUT，其他状态只续取。
- 选择冲突 manifest 副本时保留两份的 batch 历史、raw 哈希和来源路径；先保存事实并集再归档，处理中断也不会丢失上传依据。其他 JSON 冲突沿用用户选择的版本。
- 旧缓存目录存在但尚未导入时，等待并从存量上传清单排除；`IMPORTED.json` 不含时间戳，已有旧标记经忽略 `importedAt` 校验后原样保留。raw 每个成员必须与已有字节一致，才补写 manifest。
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

以下是 `src/core/` 中实际导出的接口，代码是最终依据。模块只从 `src/core/` 引用，彼此不引用。

### 5.1 模块入口（`module.ts`）

每个模块的 `index.ts` 导出：

```ts
export interface XxxSettings { … }                         // 本模块在 data.json 中的设置切片
export function readSettings(saved: unknown): XxxSettings;  // 容忍缺失和非法字段，回落默认值
export function register(context: ModuleContext<XxxSettings>): ModuleHandle;   // library 收到 LibraryContext

interface ModuleHandle { settingsSection?: SettingsSection; dispose?(): void }
interface SettingsSection { title: string; render(container: HTMLElement): void }

interface ModuleContext<S, Store extends StoreReader = StoreReader> {
  app: App; plugin: Plugin;
  events: EventBus; services: Services;
  store: Store;                    // library 是 StoreWriter，其余是 StoreReader
  settings: S; saveSettings(): Promise<void>;
  core: Readonly<CoreSettings>;    // { qwenMtEndpoint, glossary }
  secrets: SecretAccess;           // get/set('mineru' | 'dashscope')
  qwenMt: QwenMtClient;
  log: Logger;                     // 自动脱敏
  vaultPath: string; pluginDir: string;
}
```

命令、视图、事件监听都用 `context.plugin` 注册（`addCommand`、`registerEvent`、`registerDomEvent`），插件卸载时自动清理；`dispose` 只处理这之外的资源。

### 5.2 解析存储（`store.ts`）

```ts
interface StoreReader {
  list(): Promise<string[]>;                                  // 所有论文的 sha
  shaForPath(vaultPath: string): Promise<string | undefined>; // 先查 index.json，查不到再读文件算哈希（不写回）
  manifest(sha): Promise<Manifest | undefined>;
  document(sha): Promise<StoredDocument | undefined>;
  translations(sha): Promise<TranslationFile | undefined>;
  readRaw(sha, relativePath): Promise<Uint8Array>;
  readDerived(sha, relativePath): Promise<Uint8Array | undefined>;
  assetUrl(sha, assetPath): string;                           // assetPath 取自 document.assets[*].path
  conflicts(sha): Promise<string[]>;                          // 例如 ["manifest 2.json"]
  paths(): Promise<Record<string, string>>;                   // 完整的路径 → sha 索引
}
interface StoreWriter extends StoreReader {
  mineruUploads(sha): Promise<{ batchId; uploadUrl; createdAt }[]>; // 校验记录，损坏时暂停而不新建 batch
  writeMinerUUpload(sha, upload: { batchId; uploadUrl; createdAt }): Promise<void>; // write-once
  writeManifest(sha, manifest): Promise<void>;                 // manifest.sha256 必须等于 sha
  writeRaw(sha, files: Record<string, Uint8Array>): Promise<void>;   // 已存在且内容不同 → StoreError('exists')
  writeDerived(sha, relativePath, bytes): Promise<void>;
  writeDocument(sha, document): Promise<void>;
  writeTranslations(sha, file): Promise<void>;
  setPath(vaultPath, sha | null): Promise<void>;               // 串行化写 index.json
  archiveConflict(sha, fileName): Promise<void>;               // 保留当前版本：冲突副本移到 .research/conflicts/<时间>/<sha>/
  keepConflictCopy(sha, fileName): Promise<void>;              // 保留冲突副本：当前版本移走，副本改回正式文件名
  removeStaleTemps(sha): Promise<void>;
}
```

损坏的 JSON 抛 `StoreError('corrupt')`，不当作不存在。路径越界或 sha 非法抛 `StoreError('invalid-path')`。

### 5.3 规范化（`derive.ts`、`crop-canvas.ts`、`pdf.ts`）

```ts
const NORMALIZER_VERSION: number;   // 当前为 1；改规则时加一
function derive(input: {
  sha: string;
  raw: { names: string[]; read(name: string): Promise<Uint8Array> };
  pdf: AuditPdf;                    // openPdf() 的结果
  cropper: Cropper;                 // createCanvasCropper(pdf, () => createEl('canvas'), scale)
  existingDerived?: (asset: string) => Promise<Uint8Array | undefined>;   // 已有裁图直接复用
}): Promise<{ document: StoredDocument; derived: Record<string, Uint8Array> }>;   // derived 的键是 derived/ 下的路径

function openPdf(bytes: ArrayBuffer | Uint8Array): Promise<PdfDocument>;   // 调用方负责 destroy()
```

裁图规则：表格一律从原 PDF 裁图（`source-tables-v1/<blockId>.png`）；没有图片资源的图和公式裁图（`fallback-v2/<blockId>.png`）；图片题注区域涂白。

### 5.4 外部服务客户端

```ts
// mineru.ts —— 只管 HTTP，调度在 library
interface MinerUClient {
  requestUpload(sha, signal?: AbortSignal): Promise<{ batchId: string; uploadUrl: string }>;
  upload(uploadUrl, pdf: ArrayBuffer, signal?: AbortSignal): Promise<void>;
  poll(batchId, signal?: AbortSignal): Promise<{ state: 'waiting-file' | 'pending' | 'running' | 'converting' | 'done' | 'failed'; zipUrl?; progress?: { done; total }; error? }>;
  download(zipUrl, signal?: AbortSignal): Promise<Record<string, Uint8Array>>;   // 结果包全部成员，已做路径与大小检查
}
function createMinerUClient(http: Http, token: () => string | null, timeoutMs?: number): MinerUClient;
class MinerUError { retryable: boolean; status?: number; code?: number | string; readonly taskMissing: boolean }
const MAX_PDF_BYTES, MAX_PDF_PAGES;

// qwen-mt.ts
interface QwenMtClient { translate(request: { text; model; terms: Term[]; timeoutMs; signal? }): Promise<string> }
const FULL_TEXT_MODEL = 'qwen-mt-plus', SELECTION_MODEL = 'qwen-mt-flash';
class QwenMtError { retryable: boolean; status?: number }
class PlaceholderMismatchError {}               // 可重试，绝不写入
function termsKey(text, terms): string;          // 写入 translation.zh.json 的 termsKey
function termsFor(text, terms): Term[];

// http.ts
type Http = (request: RequestUrlParam) => Promise<{ status; headers /* 小写名 */; text; arrayBuffer; json }>;
function obsidianHttp(requestUrl): Http;
```

MinerU 每个 HTTP 操作默认 120 秒超时，可取消等待；Obsidian requestUrl 底层请求可能继续，因此取消或超时不代表 PUT 未到服务端。`taskMissing` 仅对应官方 `-60012`（找不到任务）：仅导入的旧 batch 在该错误下可退回首次上传，并保留到 previousBatchIds。认证、额度、限流、普通 HTTP 错误、服务端 failed 都保留 batch。错误码依据 [MinerU 官方文档](https://mineru.net/apiManage/docs)。

### 5.5 任务执行（`queue.ts`）

```ts
class TaskQueue {
  constructor(concurrency: number);
  enqueue<T>(key, run: (signal: AbortSignal) => Promise<T>, options?: { priority?: boolean }): Promise<T>;  // 同一 key 重复入队直接拒绝
  prioritize(key); cancel(key); pause(); resume(); clear();
  readonly paused: boolean; readonly size: number; has(key): boolean;
}
function withRetry<T>(run: (attempt) => Promise<T>, options?: { delays?; signal?; isRetryable?(error); onRetry?(attempt, error, delayMs) }): Promise<T>;
const RETRY_DELAYS_MS = [2 s, 8 s, 30 s, 2 min, 10 min];
class CancelledError {}
function attemptsOf(error): number;
```

### 5.6 跨模块服务（`services.ts`）和工具栏

```ts
interface Services { pipeline?: PipelineControl; agent?: AgentRunner; pdfToolbar: PdfToolbar }
interface PipelineControl {          // library 在 register 时赋值 context.services.pipeline
  status(sha): Promise<Manifest | undefined>;
  requestParse(vaultPath): Promise<void>;     // 文献库外 PDF，reader 先征得你同意
  prioritize(sha): void; retry(sha): void; cancel(sha): void;
}
interface AgentRunner {              // agent 赋值 context.services.agent，library 用于影响因子查询
  runReadOnly(prompt, options: { timeoutMs; signal?; outputSchema?: object; allowWebSearch?: boolean }): Promise<string>;
}
interface PdfToolbar {
  register(button: { id; order; icon; label; onClick(leaf, element); update?(leaf, element) }): () => void;
  refresh(): void;
}
function leafId(leaf): string;       // 事件载荷里的 leafId
```

工具栏序号：阅读模式 10，划线翻译 20，生成笔记 30。

### 5.7 其他

- `hash.ts`：`sha256Bytes`（分片让出主线程）、`sha256Text`、`segmentHash`、`normalizeSegmentText`。
- `secrets.ts`：`redact`、`errorMessage`、`registerSecretForRedaction`。
- `obsidian-internal.d.ts`：Obsidian 和 pdf.js 缺失类型的唯一位置；`electron.d.ts`：Electron `webUtils`（附件取本地路径）。

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

### 6.1 阅读层 DOM 约定（reader 提供，selection 依赖）

| 元素 | 约定 |
|---|---|
| 阅读层根元素 | `.pdf-reader-content`，属性 `data-pdf-reader-active="true|false"`、`data-lang="en|zh"` |
| 双层单元 | `.pw-block`，内含两个 `.pw-layer`，各带 `lang="en"` / `lang="zh"`；当前不显示的那层带 `aria-hidden="true"` |
| 界面元素 | 阅读层内所有不属于论文正文的元素（"原文 p.N""复制页链"等工具按钮、页码标记、折叠标题、缺译文标记、状态提示）带 `data-pw-ui` 属性 |

selection 取选区文字时，删除克隆内容中所有 `[aria-hidden="true"]` 和 `[data-pw-ui]` 节点；落在 `lang="zh"` 层或 `data-lang="zh"` 根元素内的选区不翻译。

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

## 9. 笔记 skill 与 lint（`skills/paper-note/`）

- `skills/paper-note/index.ts` 导出 `PAPER_NOTE_SKILL: string`：传给 CLI 的完整指令文本（SKILL.md 加需要的 references，由 note-skill 拼接）。构建时 `.md` 作为文本打包；测试中由 `tests/setup.ts` 以同样方式加载。
- `skills/paper-note/lint.ts` 导出 `lintNote(markdown, options?): { ok, problems: { rule, message, line?, section? }[], length }`。agent 在生成后调用；"检查当前笔记"命令也调用它。签名已冻结，规则由 note-skill 实现。
- 模板的 9 个二级标题（按顺序）：摘要翻译、研究背景、前人工作与不足、作者的思考路径、本文内容与创新点、论点与证据、Takeaways、Follow-up ideas、与现有知识的候选关联。
- "摘要翻译"一节由 agent 程序填入（取 `role: "abstract"` 块的译文），模型输出时该节留空标记 `<!-- abstract-translation -->`，agent 替换。
- `skills/paper-note/fulltext.ts` 导出 `fullText(document: StoredDocument): string`：交给 CLI 的规范化全文（Markdown，不含页码；行首标记 `[摘要]`、`[图]`、`[表]`、`[参考文献]`）。全文格式由 skill 一方定义，agent 和评测都调用它，不各自实现。
- `skills/paper-note/output.ts` 导出 `NOTE_OUTPUT_SCHEMA` 和 `noteMarkdown(response)`，生产生成与评测共用相同 schema 和边界校验。
- 生产生成调用的两个 CLI 均为 read-only，通过 JSON schema 返回 `{ noteMarkdown: string }`，程序将字符串保存为临时 `note.md`。CLI 不得写工作区输入、vault 或其他文件。
- 候选 `note.md`：可选的 YAML frontmatter 只含 `concepts`、`materials`、`methods`、`phenomena` 四个列表（`[[链接]]` 字符串）；正文从 `## 摘要翻译` 开始，不写一级标题和其他 frontmatter。agent 取出四个列表并写入完整 frontmatter 和一级标题。

## 10. 样式

每个模块有自己的 `styles.css`（`src/<module>/styles.css`），构建时按 core、library、agent、reader、selection 的顺序合并为根目录 `styles.css`。类名一律以 `pw-` 开头。

## 11. library 产出、agent 读取的文件

agent 生成笔记时读取 library 维护的 `sources/literature/manifests/zotero-doc.json`（schema_version 1，字段与旧 Python 版一致：`items[].{sha256, destination, collection_path, parent_key, attachment_key, title, creators, year, doi, journal, issn, impact_factor*, active}`）和 `supporting-information.json`。这些字段视为冻结接口，library 修改格式前要先改本节。

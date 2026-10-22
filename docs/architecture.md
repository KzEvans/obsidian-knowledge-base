# 架构

## 1. 总览

`paper-workbench` 是一个 Obsidian 桌面插件（`isDesktopOnly: true`，`minAppVersion: 1.11.4`），取代 zotero-doc-sync、codex-note-chat、pdf-reading-mode、pdf-selection-translator 四个插件和 Python runner。

数据流：

```
Zotero 本地 API
   │  library/zotero（每 3 小时 + 启动 + 手动）
   ▼
sources/literature/pdf/<collection>/*.pdf  ──► vault 中可见，反链、出链照常
   │  library/pipeline（发现 → 复制 → 上传解析 → 规范化 → 翻译 → 就绪）
   ▼
.research/papers/<sha256>/      ◄── 只有流水线写入
   manifest.json  raw/  derived/  document.json  translation.zh.json
   │                          │
   │ 只读                      │ 只读
   ▼                          ▼
reader（单栏、中英对照、划线翻译）   agent（手动生成笔记、笔记问答）
                                   │ 写入（候选工作区 → 冲突检查 → 发布）
                                   ▼
                              wiki/papers/<collection>/*.md
```

模块之间不直接调用。状态变化通过 core 的事件总线广播，跨模块请求通过 core 定义的接口完成（第 4 节）。

## 2. 目录与模块边界

```
src/main.ts                 入口：创建 core 上下文，依次调用各模块 register，组装设置页
src/core/                   被所有模块依赖，自身不依赖任何模块
  types.ts                  ReaderDocument 等共享类型（自 pdf-reading-mode 迁移）
  normalize.ts audit.ts native-text.ts   原样迁移
  mineru.ts                 MinerU 云端客户端（只管 HTTP，不管调度）
  qwen-mt.ts                Qwen-MT 客户端 + 术语表应用 + 占位符保护
  store.ts                  解析存储读写、原子写、冲突副本识别、路径索引
  derive.ts                 规范化阶段：normalize + audit + 原 PDF 裁图 + 图片尺寸
  queue.ts                  有并发上限和退避的任务执行器
  events.ts                 类型化事件总线
  hash.ts                   sha256（流式，分片让出主线程）
  secrets.ts                SecretStorage 读写 + 日志脱敏
  services.ts               跨模块接口登记处（AgentRunner、PipelineControl、PdfToolbar）
  settings.ts               core 自己的设置分组（MinerU、DashScope、术语表）
  obsidian-internal.d.ts    Obsidian / pdf.js 缺失类型的集中声明
src/library/                Zotero 同步、SI / 影响因子补全、流水线编排、旧缓存迁移
src/agent/                  智能体适配层、笔记生成、笔记问答、状态切换按钮
src/reader/                 阅读模式、中英对照、阅读内搜索
src/reader/selection/       划线翻译（原生 PDF 视图 + 阅读模式英文层）
skills/paper-note/          SKILL.md、references、lint 脚本、评测说明
tests/                      按模块分目录；golden/ 和 e2e/ 读取环境变量指定的本机论文
legacy/                     归档（只读）
docs/
scripts/                    deploy.mjs、precommit-scan.mjs、check.mjs
```

**eslint `no-restricted-imports` 规则：**

| 文件位置 | 禁止引用 |
|---|---|
| `src/core/**` | `src/library`、`src/agent`、`src/reader`（core 不依赖模块） |
| `src/library/**` | `src/agent`、`src/reader` |
| `src/agent/**` | `src/library`、`src/reader` |
| `src/reader/**`（不含 selection） | `src/library`、`src/agent`、`src/reader/selection` |
| `src/reader/selection/**` | `src/library`、`src/agent`、`src/reader/*`（selection 之外） |

`main.ts` 是唯一可以引用所有模块的文件。selection 和 reader 之间也隔离，因为两者由不同会话并行开发；它们只通过 core 事件和第 6.3 节的 DOM 约定配合。

**模块注册约定：** 每个模块导出

```ts
export function register(ctx: ModuleContext): ModuleHandle
// ModuleHandle = { settingsSection: SettingsSection; dispose?(): void }
```

`ModuleContext` 提供 plugin 实例、core 服务、事件总线、本模块的设置切片和保存函数。`main.ts` 只做组装，并行开发时没人需要改它。

## 3. core

### 3.1 解析存储

- 根目录：`<vault>/.research/papers/<sha256>/`。以点开头，Obsidian 不索引、不发 vault 事件，iCloud 照常同步。
- 读写走 Node `fs`（桌面专用），这样可以 `fsync` 后 `rename` 做原子写。
- **只有流水线写入。** `store` 导出两套接口：`StoreReader`（reader、agent 使用）和 `StoreWriter`（只有 library 拿得到，由 `main.ts` 传入）。lint 规则保证 reader、agent 拿不到 `StoreWriter`。
- **iCloud 冲突副本：** 读目录时识别 `manifest 2.json`、`document 3.json` 这类名字。发现后：
  - 不自动覆盖或合并，该论文进入 `conflict` 状态；
  - 状态栏和阅读模式给出提示，列出冲突文件；
  - 提供保留当前或副本的操作，由你确认后把另一份移到 `.research/conflicts/<时间>/`；manifest 的 batch 历史、raw 哈希和来源路径只增不减，以免旧副本触发重复上传。
- **`raw/` 不可修改。** 写一次后不再碰。规范化版本升级时从 `raw/` 离线重建 `document.json` 和 `derived/`，绝不重新上传。
- **路径索引：** `.research/index.json` 记录 vault 路径 → sha256。library 在 PDF 的 `rename`、`delete`、`create` 事件里维护它，reader 打开 PDF 时先查索引，查不到再计算哈希；本机收到 PDF 修改事件后，reader 对新文件版本直接验算字节哈希，避免把尚未更新的路径索引当成新文件身份。同一份 PDF 出现在多个 collection（例如 Duraivel 2026 同时在两个文件夹）时共用一份存储，`manifest.sources` 列出所有路径。

### 3.2 规范化（`derive.ts`）

输入 `raw/` 和原 PDF，输出 `document.json` 和 `derived/`：

1. `normalizeContentList`（原样迁移）。
2. 解析资源引用；缺失的记一条警告。
3. `auditNativeText`：用 Obsidian 自带的 pdf.js（`loadPdfJs()`）读原生文字层校对（原样迁移）。
4. 为表格、无资源的图片和公式从原 PDF 裁图，写 `derived/source-tables-v1/`、`derived/fallback-v2/`。这一步原来在阅读模式里做。
5. 读所有图片的文件头尺寸，写进 `document.json`。
6. 标出摘要块（`role: "abstract"`），供"摘要翻译"一节直接取用。

每处理一页 `await` 一次（pdf.js 本身就是异步的），裁图和标注也按块分片，保证单次占用主线程不超过 50 ms。

`normalizerVersion` 是一个整数常量。改动 normalize、audit 或裁图规则时加一；流水线发现存储里的版本较旧，就从 `raw/` 离线重建。

### 3.3 Qwen-MT 客户端

- 从现有 `qwen-mt.ts` 迁移：OpenAI 兼容接口、`translation_options`、超时、取消、错误信息。
- 术语表：设置里维护的 `{source, target}` 列表。每段只发送该段实际出现的术语（`translation_options.terms`，以百炼文档为准，阶段 1 实测确认）。
- 占位符保护：送出前把行内公式 `$…$`、`<sup>…</sup>`、`<sub>…</sub>` 换成编号占位符，返回后还原。占位符集合对不上（多、少、重复、改写）就抛 `PlaceholderMismatchError`，由调用方重试，绝不写入损坏的译文。占位符的具体写法由 core 实现时用真实接口测出最稳的格式。
- 调用方传模型名：全文翻译和划线翻译可以用不同模型（全文 `qwen-mt-plus`，划线 `qwen-mt-flash`）。

### 3.4 MinerU 客户端

从 `service.ts` 拆出纯 HTTP 部分：申请上传地址、上传、轮询、下载结果包、解包和安全检查。不包含调度和缓存逻辑。Token 从 SecretStorage 读取，错误信息中不出现 Token 和上传地址的签名参数。

### 3.5 任务执行器（`queue.ts`）

- 每类资源一个执行器：MinerU（默认并发 2）、Qwen-MT（默认并发 4）。数值写成常量，不做设置项。
- 失败按指数退避重试（2 s、8 s、30 s、2 min、10 min），超过次数进入失败状态。401/403、额度不足这类不可重试的错误直接失败。
- 支持优先级插队、取消单个任务、全局暂停。

### 3.6 事件总线

类型化的发布订阅，事件列表见 `contracts.md`。用于隐藏目录里的状态变化（Obsidian 不会为它们发 vault 事件）。

### 3.7 跨模块接口（`services.ts`）

模块之间需要"请求"而不只是"通知"时，由提供方在 register 时登记实现，使用方通过 core 调用。如果提供方没有加载，接口返回 `undefined`，使用方要处理这种情况。

| 接口 | 提供方 | 使用方 | 用途 |
|---|---|---|---|
| `PipelineControl` | library | reader、agent | 查询某篇的状态、请求处理文献库外 PDF、优先处理、重试 |
| `AgentRunner` | agent | library | 影响因子自动查询 |
| `PdfToolbar` | core 自己实现 | reader、selection | 在原生 PDF 视图工具栏登记按钮，按序号排列 |

## 4. library

Zotero 本地 API 经 Obsidian `requestUrl` 调用；读取请求携带 `Zotero-Allowed-Request: 1`，兼容 Zotero 对浏览器样式请求的检查（[官方说明](https://www.zotero.org/support/dev/zotero_10_for_developers#local_http_server_and_local_api)）。

### 4.1 流水线状态机

```
discovered → copied → uploading → parsing → normalizing → translating → ready
                 ↘          ↘          ↘           ↘             ↘
                                    failed(stage, error, attempts)
```

- `discovered`：在文献库目录发现 PDF，或你确认处理一个库外 PDF。
- `copied`：PDF 已在 vault 中（Zotero 同步复制完成，或库外 PDF 本来就在）。计算 sha256，建立存储目录和 manifest。
- `uploading`：申请上传地址并上传。**申请地址后、PUT 前把 `batchId` 写进 manifest 和独立的不可变上传记录**。PUT 报错或重启后先 poll，仅 waiting-file 才复用原地址 PUT；其他状态只续取，不申请新 batch。
- `parsing`：轮询 MinerU。下载结果包，解包写入 `raw/`。
- `normalizing`：执行 3.2 节。
- `translating`：逐段翻译，写 `translation.zh.json`（每完成若干段原子落盘一次，并广播进度）。
- `ready`：可读、可生成笔记。

每一步开始及翻译入队前检查取消；卸载后不再开始写入或发事件（已拿到的 batch 上传记录仍须保存）。启动时对可重试失败恢复一次，用户取消不自动恢复。

每一步都幂等：启动时读所有 manifest，从各自记录的阶段继续。阶段完成的判定只看存储里的文件和 manifest，不依赖内存状态。

### 4.2 自动与手动

- **自动：** 文献库目录（`sources/literature/pdf/`）里的新 PDF 自动进流水线。
- **首次启用：** 先扫描存量，按 sha 去重，列出篇数和预计 MinerU 页数（用 pdf.js 读页数，已有旧缓存的不计），弹窗等你确认才开始。确认结果记在插件设置里。
- **库外 PDF：** 阅读模式打开时，经确认后调用 `PipelineControl.requestParse`。
- 状态栏：`解析 3/27 · 翻译 1/5`，点击打开流水线面板（列表 + 暂停 / 取消 / 重试 / 优先）。

### 4.3 Zotero 同步与补全

行为照搬 `sync_zotero_doc.py`、`supporting_information.py`、`journal_metrics.py`、`automatic_impact_factor.py`，用 TypeScript 重写，对应的 Python 测试改写为 TS 测试。网络请求统一用 Obsidian `requestUrl`。Zotero 没有运行时安全跳过，下轮重试；本地已有文献的流水线不受影响。

### 4.4 笔记位置跟随 collection

论文的 collection 变化时，library 同时移动 PDF 和对应笔记（`fileManager.renameFile` 会更新所有链接）。笔记和论文的对应关系看笔记 frontmatter 的 `zotero_attachment`。

### 4.5 旧缓存迁移

见 `migration.md`。

## 5. agent

### 5.1 适配层

```ts
interface AgentAdapter {
  run(request: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
// AgentRequest: prompt、instructions、cwd、readableDirs、writableDirs、images、
//               resumeId、model、timeoutMs、mode: "read-only" | "write-workspace"
// AgentEvent:   { type: "text-delta" } | { type: "session", id } | { type: "done", text } | { type: "error" }
```

- Codex：`codex exec --json`，续聊用 `codex exec resume <id>`。Claude：`claude -p --output-format stream-json`，续聊用 `--resume <id>`。具体参数（沙箱、可写目录、图片、跳过用户配置）由 agent 会话对照本机 `--help` 输出确定，不凭记忆写。
- 子进程以独立进程组启动（`detached: true`），取消或超时时 `process.kill(-pid)` 结束整组。
- CLI 路径：先看设置，再按顺序探测 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`。Obsidian 从图形界面启动时不继承 shell 的 PATH，所以子进程的 PATH 也要显式补全。
- 代理地址设置后注入子进程的 `HTTP(S)_PROXY`、`ALL_PROXY`，`NO_PROXY` 包含 localhost。
- skill 内容（SKILL.md 和 references）在构建时打包进插件，每次调用通过指令参数传给 CLI，不依赖 `$CODEX_HOME/skills` 或 `~/.claude/skills` 里的安装。这样两个 CLI 读到的是同一份 skill，也不会被你的全局 hooks 和插件干扰。

### 5.2 笔记生成

1. 你在论文的 PDF、阅读模式或笔记里执行"生成笔记"，或在文献列表里多选。只对 `ready` 的论文开放。
2. 在临时目录建工作区，放入：规范化全文（纯文本 Markdown，带图表编号，不带页码）、元数据、`purpose.md`（若存在）、vault 笔记和概念页的标题清单。
3. 两个 CLI 都用只读模式读取工作区和 vault（用于"候选关联"一节的搜索），按 JSON schema 返回 `{ noteMarkdown: string }`；程序把候选写成临时 `note.md`，CLI 不获得任何文件写权限。
4. 程序替换整个"摘要翻译"小节为完整 Qwen-MT 摘要译文；有段落缺译就保留占位标记并提示，不采用模型自写的摘要。再写 frontmatter、跑 lint。
5. 发布前检查目标笔记：若生成期间被改过（mtime + 内容哈希与开始时的快照不同），不覆盖，保留候选稿并提示。新建时目标必须不存在，即使文件名与另一篇笔记碰撞也不覆盖。发布边界再次检查取消。
6. 重新生成时保留 `## 人工复核`、`# 提问`、`user-notes` 标记块和已合并的精读块，规则与 Python 的 `protected_spans` 一致。

### 5.3 笔记问答

浮窗行为与现在一致；准备上下文时即占用发送状态，防止重复请求。CLI 收到最终事件后继续读取到进程正常退出，确保会话保存；然后才向调用方报告完成。问答写入时将正文标题降级到问题小节以下，标题和受保护区扫描忽略代码围栏。论文全文从解析存储读；会话按笔记保存（存 CLI 的会话 id 和消息），切换适配器后旧会话无法续接，新开一轮。

## 6. reader

### 6.1 阅读模式

在原生 PDF 视图上叠一层阅读层（与现在相同），所以视图对应的文件仍是 PDF，反链、出链、页码链接照常。数据只来自 `StoreReader`：

- 存储没有这篇：显示"排队中 / 解析中 / 翻译中"和进度，提供"优先处理这篇"；库外 PDF 先询问是否处理。
- 失败：显示失败阶段和错误，提供"重试"。
- `ready`，或者规范化已完成但翻译未完成：可读，中文切换按钮按 6.2 处理。

订阅 `paper:stage-changed`、`paper:translation-progress` 事件，状态变化时刷新。

### 6.2 中英对照

每个可翻译块（段落、标题、题注、脚注、列表）渲染成：

```html
<div class="pw-block" data-block-id="…">          <!-- display: grid -->
  <div class="pw-layer" lang="en">…</div>          <!-- grid-area: 1 / 1 -->
  <div class="pw-layer" lang="zh" aria-hidden="true">…</div>   <!-- grid-area: 1 / 1 -->
</div>
```

- 分批渲染期间的语言选择以最新状态为准；期间收到的译文更新在挂载结束后统一补刷，避免后半篇停留在旧译文。普通打开优先恢复按 SHA 保存的页码，显式页链和原位重建位置优先于历史位置。
- 当前不显示的那层：`visibility: hidden`、`aria-hidden="true"`、`user-select: none`，不参与阅读内搜索和复制。
- 块高度等于两层中较高的那层，切换只改根元素上的 `data-lang`，靠 CSS 选择器切换可见性，不触发重新排版。
- 中文统一一个字号，取让全文中英高度差总和最小的那个值，在首次渲染时按样本段落的自然高度测一次后固定（测量副本的层 align-self: start，不读取 grid 拉伸后的共同高度），不逐段调整。
- 公式、图片、表格只渲染一次；题注用同样的双层结构。中文层里的行内公式和上下标照常渲染。
- 每个窗口最多缓存 512 个公式排版模板，重开时克隆独立节点并重分配编号及 SVG 定义的 ID 和内部引用；只有样式刷新成功的模板才跳过 MathJax 刷新，需注册命名标签或引用的公式不缓存。
- 缺译文的段落中文层显示英文原文并加轻量标记，沿用英文字体和字号。翻译未开始时切换按钮置灰，进行中显示进度。
- 工具栏按钮 + 命令（可绑定快捷键）。

**验收：** 3 篇论文 × 3 种视图宽度 × 至少 20 个滚动位置，切换前后视口顶部那个块到视口顶端的距离变化 ≤ 1 px。测试脚本在 `tests/e2e/`，通过 Obsidian 的开发者控制台注入运行（具体方式由 reader 会话确定）。

### 6.3 划线翻译与 reader 的约定

selection 不引用 reader 的代码，只依赖：

- core 事件 `reader:mode-change`：`{ leafId, active, language: "en" | "zh" }`；
- DOM：阅读层根元素 `.pdf-reader-content[data-pdf-reader-active="true"][data-lang="en|zh"]`。

`language` 为 `zh` 时不触发划线翻译。两个工具栏按钮通过 core 的 `PdfToolbar` 登记，阅读模式序号 10、翻译序号 20，保证相邻。

## 7. 设置页

`main.ts` 按顺序渲染各模块的设置分组：

| 分组 | 内容 |
|---|---|
| 服务与密钥（core） | MinerU Token、DashScope Key、Qwen-MT 地址、测试连接、术语表 |
| 文献库（library） | Zotero API 地址、collection 名、流水线暂停开关、存量补跑入口、SI 和影响因子相关 |
| 智能体（agent） | 默认适配器（Codex / Claude）、两个 CLI 路径、各自模型（可选）、代理地址、生成超时 |
| 阅读（reader） | 字号、行距、滚动诊断 |
| 划线翻译（selection） | 字符上限、超时 |

所有设置存在同一个 `data.json`，按模块分命名空间。密钥只在 SecretStorage。

## 8. 工具链与质量门槛

- 包管理 pnpm，Node 版本锁定在 `.nvmrc` 和 `package.json#engines`。安装前问你。
- TypeScript `strict` + `noUncheckedIndexedAccess`，新代码不用 `any`。
- eslint：`eslint-plugin-obsidianmd` + 第 2 节的模块边界规则。
- 测试：沿用现有的 `node --test` + `tsx`，DOM 测试用 `linkedom`（与 pdf-reading-mode 一致，迁移成本最低）。golden 测试需要在 Node 里跑 audit，加 `pdfjs-dist` 开发依赖，版本对齐 Obsidian 1.14.4 内置的 pdf.js。
- `pnpm check` = typecheck + lint + test + 提交前扫描。
- 构建 esbuild，部署脚本把 `main.js`、`manifest.json`、`styles.css` 复制到 vault 的 `.obsidian/plugins/paper-workbench/`。

## 9. 已知风险

| 风险 | 应对 |
|---|---|
| 另一台 Mac 打开同一 vault 也会跑流水线 | manifest 里记录的 `batchId` 经 iCloud 同步后能避免重复上传，但同步有延迟。默认假设只有一台 Mac，在 docs 中写明 |
| `.research/` 占 iCloud 空间（每篇约 3–10 MB，含图片和 `layout.json`） | 30 多篇约 100–300 MB；你的私密备份也会包含它，这正好保护 MinerU 额度 |
| Obsidian 内部 DOM（PDF 视图工具栏、`setEphemeralState`）随版本变化 | 集中在 `obsidian-internal.d.ts` 和少数适配函数里，升级后重点验证 |
| CLI 参数随版本变化 | 适配层启动时检查 `--version`，参数以 `--help` 为准，并有一条冒烟测试 |

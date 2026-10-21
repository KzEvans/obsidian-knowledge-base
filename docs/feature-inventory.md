# 功能清单

本文列出四个旧插件、Python runner 和 Zotero 同步脚本的全部现有功能，并给出处置：

- **保留**：行为不变，只换实现位置。
- **迁移改造**：保留目的，按新架构改写行为。
- **删除**：不再提供，代码进 `legacy/` 归档。
- **冻结**：暂不迁移，代码进 `legacy/`，相关 frontmatter 字段保留，以后可恢复。

标 ✔ 的条目原本待确认，已于 2026-10-21 按建议确认，决定汇总在文末。

调研依据：三个仓库的源码和测试、vault 中的实际配置与缓存、Codex 的三段历史对话、最近一次 Claude 会话。

## 1. zotero-doc-sync 插件 + `system/zotero-sync/` 脚本

| 功能 | 处置 | 新位置 / 说明 |
|---|---|---|
| 读取 Zotero 本地 API 的 Doc collection 及全部子 collection | 保留 | `library/zotero` |
| 子 collection 名称清洗：非法字符替换、150 字节截断、根层 `images`/`close-reading` 加 key 后缀、同级重名加 key 后缀 | 保留 | 有回归测试（嵌套路径 bug） |
| 条目属于多个 collection 时取最深的；同深度保持原归属，否则按名称排序 | 保留 | |
| PDF 镜像到 `sources/literature/pdf/<collection-path>/`，文件名 `<原名> (<attachment key>).pdf` | 保留 | |
| 原子复制；源文件变化时先把旧版存到 `sources/literature/history/` | 保留 | |
| 区分主 PDF 和 SI / peer review 等辅助附件 | 保留 | |
| Zotero 删除的条目在 manifest 标 `active: false`，不删 PDF | 保留 | |
| 已移出的旧版本 PDF 按 DOI 跟随当前分类移动；目标位置内容不同则报错不覆盖 | 保留 | |
| 生成 `manifests/zotero-doc.json`、`index.md`、`references.bib`；BibTeX 失败时保留上一版 | 保留 | manifest 格式保持 schema_version 1 兼容 |
| SI 发现（Zotero 子附件、Figshare、出版社页面）、PDF 魔数校验、缓存到 `sources/literature/si/<parent key>/` | 保留 | `library/enrichment`，每小时一次 |
| 影响因子：Zotero Extra → 本地表 → 自动查询；拒绝五年 IF 等替代指标；缺失写 `null` | 迁移改造 ✔ | 自动查询现在是 OpenAlex 找期刊主页 + **Codex 联网搜索**读官方页面。OpenAlex 本身不提供 JIF。决定 Q3 |
| 影响因子回填到已有笔记 frontmatter；上游为空时不清空人工填写值 | 保留 | 用 `fileManager.processFrontMatter` |
| 启动时同步一次、每 3 小时同步、手动同步命令、ribbon 按钮 | 保留 | |
| 状态栏分别显示同步结果和后台任务进度 | 迁移改造 | 合并成一个状态栏项：同步状态 + 流水线进度 |
| `--organize-only` 和 `generation_deferred` 暂存新论文 | 删除 | 笔记不再自动生成，不需要暂存 |
| 每分钟处理一条知识任务（Forge 生成） | 删除 | 由新流水线（解析 + 翻译）取代，笔记改为手动发起 |
| 精读五条命令（开始/提示/提交/解释/合并）、`paragraph_reading` 勾选自动启动 | 删除 | 决策 6 |
| 整合当前已审核笔记 | 冻结 | 决策 5 |
| 知识关联报告、证据对比、概念维护、研究问题维护 | 冻结 | 决策 5 |
| 每周健康检查（lint，调用模型） | 冻结 ✔ | 依赖整合层的规范页；决定 Q5 |
| 重试最早的失败任务 | 迁移改造 | 流水线的"重试单篇" |
| 只校验并修复当前 Forge 草稿 | 迁移改造 | 改为"检查当前笔记"命令，运行 paper-note lint，不调用模型 |
| 显示知识任务队列状态 | 迁移改造 | 流水线面板 |
| 文件锁防止同步重叠 | 迁移改造 | 进程内互斥，不再需要跨进程锁 |

## 2. codex-note-chat 插件

| 功能 | 处置 | 新位置 / 说明 |
|---|---|---|
| Markdown 笔记标签页工具栏按钮、命令 | 保留 | `agent/chat` |
| 可拖动、八方向缩放、记忆位置尺寸的浮窗；键盘移动 | 保留 | |
| 回答流式输出、停止按钮、Enter 发送 / Shift+Enter 换行 | 保留 | |
| LaTeX 渲染（Obsidian MathJax） | 保留 | |
| 上下文：当前笔记 | 保留 | |
| 上下文：来源 PDF（让 Codex 自己读 PDF 文件） | 迁移改造 | 改为从解析存储读规范化全文，作为纯文本给模型 |
| 上下文：捕获选区（编辑和阅读模式都可） | 保留 | |
| 上下文：直接出链笔记，最多 12 篇 | 保留 | |
| 上下文：`purpose.md`，普通问答最多 6000 字 | 保留 | |
| 上下文："加入相关知识"（调用 Python `knowledge-context` 检索） | 冻结 ✔ | 依赖 Python runner；你的设置里一直是关闭的。决定 Q4 |
| 可折叠的"本轮上下文"区 | 保留 | |
| 附件：每次最多 8 个文件或图片，图片 25 MB 上限 | 保留 | Codex 用 `-i`；Claude 通过可读路径。适配层各自实现 |
| 按笔记保存会话（线程 id、消息、已写入条数），笔记改名时跟随 | 保留 | 迁移旧 `sessions` 数据，见 migration.md |
| "写入笔记"：追加到 `# 提问`，`## 序号` / `Q：` / `A：` 格式，序号延续 | 保留 | |
| 只读沙箱、拒绝服务端发起的审批请求 | 保留 | 适配层统一实现 |
| 人工复核："开始复核"按清单逐项核对 PDF 页码，`REVIEW_STATUS` 标记，"完成审核"写 `reviewed_content_sha256` | 删除 ✔ | 复核清单依赖页码引用，新模板没有页码；审核哈希是为整合层服务的。改为 `status: draft / reviewed` 切换按钮。决定 Q2 |
| 通过 `codex app-server --stdio` 通信 | 迁移改造 | 改走 `codex exec --json` / `codex exec resume`，以及 `claude -p --output-format stream-json` / `--resume` |
| 读取 `config.json` 的 `codex_path`、`proxy_url` | 迁移改造 | 进插件设置：CLI 路径（自动探测 + 手动指定）、代理地址（你现在在用，所以保留） |

## 3. pdf-reading-mode 插件

| 功能 | 处置 | 新位置 / 说明 |
|---|---|---|
| MinerU 云端 VLM 上传、轮询、下载，任务 id 落盘以便续取 | 迁移改造 | `core/mineru` 客户端 + `library` 流水线调度。阅读模式不再直接上传 |
| 200 MB / 200 页上限检查 | 保留 | `core/mineru` |
| 结果包路径安全检查、大小上限 | 保留 | `core/mineru` |
| 缓存目录 `cache/<sha>-vlm-v1/` + `CACHE_SIGNATURE` 离线重建 | 迁移改造 | 换成 `.research/papers/<sha>/`，`normalizerVersion` 取代 `CACHE_SIGNATURE` |
| `normalize.ts` 全部规则（ACS 控件、"Downloaded from"、logo 和封面、作者行、出版信息、参考文献范围、跨页续段、多面板图组合、图内 OCR 并入 alt） | 保留 | `core/normalize`，原样迁移，测试一并迁移 |
| `audit.ts` 原生文字层校对（连字、ff/ffi 补字母、跨栏重复含丢单字母、下标恢复、空块补齐、页级差异警告） | 保留 | `core/audit`，原样迁移 |
| `native-text.ts` 区域文字提取 | 保留 | `core/native-text` |
| 表格、无资源图片、公式从原 PDF 裁图（`source-tables-v1/`、`fallback-v2/`） | 迁移改造 | 由阅读模式挪到流水线"规范化"阶段，写入 `derived/`。阅读模式只读 |
| 图片尺寸预读（只读文件头） | 迁移改造 | 同上，结果写入 `document.json` |
| 单栏渲染：Times New Roman、字号 16–24、行距 1.3–1.8、首行缩进 | 保留 | `reader/render` |
| 辅助块（作者、出版信息、页眉页脚）移到所属小节末尾并折叠；参考文献集中折叠于文末 | 保留 | |
| HTML 白名单清洗、MathJax、公式失败回退 | 保留 | |
| 图片懒加载、预留比例、靠近视口才解码 | 保留 | |
| 长文分批渲染、让出主线程 | 保留 | |
| 页码追踪、页码输入跳转、`#page=N` 链接在阅读层跳转、精确选区/注释链接回到原生视图 | 保留 | |
| 段落"查看原页"、"复制页链"（`generateMarkdownLink`） | 保留 | |
| 阅读内搜索（不匹配按钮和页码标记） | 迁移改造 | 中文模式下只搜可见层 |
| 核对提示弹窗、图片放大弹窗 | 保留 | |
| 阅读位置记忆、改名后跟随 | 迁移改造 | 改为按 PDF 的 sha256 记录，改名移动都不丢 |
| PDF 文件被修改后重新加载 | 迁移改造 | 内容变了就是新 sha，阅读模式显示新文件的处理状态 |
| 内存中保留最近 8 篇 | 保留 | |
| 多标签页共享同一 PDF 的读取和处理 | 迁移改造 | 处理由流水线统一管理，天然去重 |
| 滚动性能诊断开关（默认关） | 保留 | 诊断文件写到插件目录，不写解析存储 |
| `pdf-reading-mode:mode-change` 事件、`.pdf-reader-content[data-pdf-reader-active]` DOM 约定 | 迁移改造 | 改为 core 事件总线的 `reader:mode-change`，增加语言字段；DOM 属性保留供样式使用 |
| 设置：MinerU Token | 迁移改造 | 移到 core 设置分组 |

## 4. pdf-selection-translator 插件

源码以 `~/Documents/Obsidian/src/` 为准（比知识库仓库里的副本多了阅读模式切换和换文件时的清理）。

| 功能 | 处置 | 新位置 / 说明 |
|---|---|---|
| 每个 PDF 标签页独立开关 | 保留 | `reader/selection` |
| 选区结束后自动翻译，弹窗优先右侧、不够再左下上，限制在标签页内 | 保留 | `geometry.ts` 原样迁移 |
| 复制译文、Esc 关闭、窄分栏/弹出窗口/滚动适配 | 保留 | |
| 会话内缓存相同文本的译文 | 保留 | |
| 原生 PDF 视图和阅读模式英文层都可用 | 保留 | |
| 阅读模式中文层不触发 | 新增 | 规格 3.7 |
| 切换模式或换文件时清理选区、请求、弹窗 | 保留 | |
| Qwen-MT 客户端（`qwen-mt-flash`，兼容 OpenAI 接口，超时与取消） | 迁移改造 | 移到 `core/qwen-mt`，全文翻译共用，加术语表 |
| 设置：API Key（SecretStorage）、API 地址、测试连接、字符上限、超时 | 迁移改造 | Key、地址、测试连接移到 core 设置分组；字符上限和超时留在 selection |
| 设置：目标语言 | 删除 ✔ | 全文翻译固定中文，划线翻译跟着固定中文，少一个选项。决定 Q6 |
| 工具栏按钮位置 | 迁移改造 | 由 core 的工具栏按钮登记接口统一排序，"翻译"和"阅读模式"相邻 |

## 5. Python runner（`system/knowledge/`）和 skills

| 功能 | 处置 | 说明 |
|---|---|---|
| 扫描来源、任务队列、文件锁、`pending.json` | 删除 | 由 `library` 流水线取代 |
| 本机 MinerU pipeline / `pdftotext` 回退、`extracts/papers/` | 删除 | 决策 2。`extracts/papers/` 原地保留，不复用 |
| Forge 计划 / 撰写两阶段、30 分钟墙钟、10 分钟停滞、token 预算、重连检测 | 删除 | 新流程单次调用，由适配层的超时和取消兜底 |
| 候选工作区生成、发布前检查原笔记是否被改动 | 迁移改造 | `agent/notes` |
| 保留 `## 人工复核`、`# 提问`、`user-notes` 标记块、已合并的精读块 | 保留 | `agent/notes`，规则与 `protected_spans` 一致 |
| 笔记文件名和一级标题 `YYYY-MM-DD - 第一作者 - 标题` | 保留 | |
| 笔记目录跟随 Zotero collection（`wiki/papers/<collection-path>/`），collection 变化时移动笔记并更新链接 | 保留 | `library` 负责（与 PDF 移动同一时机），用 `fileManager.renameFile` 自动改链接 |
| 图片裁剪、`wiki/papers/images/<笔记名>/` | 删除 | 新规则不嵌图。已有图片目录原地保留 |
| `wiki/index.md` 草稿区的自动维护 | 冻结 ✔ | 属于整合层的索引。决定 Q5 |
| 实验笔记摄取（`type: experiment-analysis`） | 冻结 ✔ | 现在 0 篇实验笔记。决定 Q5 |
| 审核哈希门槛 `reviewed_content_sha256` | 删除 ✔ | 决定 Q2 |
| integrate、knowledge-map、compare-evidence、maintain-* | 冻结 | 决策 5 |
| `knowledge-context` 本地检索 | 冻结 ✔ | 决定 Q4 |
| 检索评测脚本、`backup_vault.py` | 归档 | `backup_vault.py` 在你的私密备份仓库里另有一份，自动备份不受影响 |
| `skills/forge-paper-note`（~124 KB） | 删除 | 由 `skills/paper-note` 取代，旧版进 `legacy/` |
| `skills/paper-intensive-reading`、`skills/paper-reading` | 删除 | 决策 6，进 `legacy/` |
| `AGENTS.md` 和 `system/workflows/*.md` | 迁移改造 | 删除页码链接、图片目录、精读条款，改写研究方向条款（决策 8）。冻结功能的工作流文档原样进 `legacy/` |

## 6. 笔记 frontmatter 字段

| 字段 | 新笔记 | 说明 |
|---|---|---|
| `type`、`status`、`title`、`display_title`、`generated_date`、`generated_at`、`zotero_item`、`zotero_attachment`、`doi`、`source_pdf`、`source_sha256`、`year`、`journal`、`issn`、`impact_factor*` 四项 | 写 | |
| `concepts`、`materials`、`methods`、`phenomena` | 写 | 冻结的整合层要用，决策 5 要求保留 |
| `reviewed` | 写 | 与 `status` 同步（`reviewed` ⇔ `status: reviewed`），整合层以后要用 |
| `source_id` | 写 | 改为 `paper:<attachment key>:<sha 前 16 位>`，格式不变 |
| `supporting_information` | 写 | SI 列表仍有用 |
| `extract`、`images_dir`、`supporting_information_used`、`generation_stage` | 不写 | 对应功能已删除 |
| `paragraph_reading*` 四项 | 不写 | 决策 6 |
| `reviewed_at`、`reviewed_with`、`reviewed_content_sha256`、`review_warnings_accepted`、`integrated_at` | 不写 | 审核哈希已删除（决定 Q2） |

**已有笔记不批量改写。** 旧字段留在原笔记里，只有当你对某篇点"重新生成"时才按新格式重写（保留人工块）。

## 7. 新增功能

| 功能 | 模块 |
|---|---|
| 解析存储 `.research/papers/<sha>/` | core |
| Qwen-MT 全文逐段翻译、术语表、占位符保护 | core + library |
| 流水线状态机、并发、重试退避、暂停 / 取消 / 重试 / 优先处理 | library |
| 首次启用的存量补跑确认（篇数 + MinerU 页数） | library |
| 文献库外 PDF 经确认后入流水线 | reader → library（经事件总线） |
| 中英对照（双层 grid，切换不移位） | reader |
| 笔记生成：单篇 / 多篇手动发起，Codex / Claude 可切换 | agent |
| `status: draft / reviewed` 切换按钮 | agent |
| paper-note skill、lint 脚本、评测集 | skills/paper-note |

## 已确认的决定（2026-10-21）

- **Q1 插件名：** `paper-workbench`，显示名 "Paper Workbench"。
- **Q2 审核：** 删除 AI 复核和审核哈希门槛，只保留 `status: draft / reviewed` 切换按钮，同步写 `reviewed: true/false`。
- **Q3 影响因子：** 保留自动查询。`library` 通过 core 的 `AgentRunner` 接口调用智能体，不直接依赖 `agent`。
- **Q4 "加入相关知识"：** 冻结。
- **Q5 健康检查、`wiki/index.md` 维护、实验笔记摄取：** 冻结。
- **Q6 划线翻译目标语言：** 删除设置，固定中文。
- **Q7 模型：** 全文翻译 `qwen-mt-plus`，划线翻译 `qwen-mt-flash`，由调用方传模型名，不加设置项。
- **已有笔记：** 不批量改写 frontmatter，旧字段只在重新生成时去掉。

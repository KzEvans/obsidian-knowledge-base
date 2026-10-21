# 迁移与回滚方案

## 1. 现状（2026-10-21 调研）

| 项目 | 现状 |
|---|---|
| 已启用插件 | pdf-selection-translator 0.3.0、realclaudian（不动）、codex-note-chat 0.4.1、pdf-reading-mode 0.1.9、zotero-doc-sync 1.7.1 |
| 文献库 | `sources/literature/pdf/` 下 35 条记录：31 条有效、4 条 inactive；4 个子 collection |
| 论文笔记 | `wiki/papers/` 下 18 篇（旧 Forge 模板，每篇 80–95 KB），0 篇已审核 |
| 阅读模式缓存 | 3 篇完整：Meng 2016、Chen 2021、Duraivel 2026（同一份 PDF 在两个 collection 中各有一条记录）；1 篇只有 `job.json`：Cai 2024（2MBHXG4J），说明当时已上传，解析结果未取回 |
| 旧解析结果 | `extracts/papers/`（本机 MinerU pipeline 格式），不复用，原地保留 |
| 知识流水线 | `ingest_paused: true`，后台生成已暂停 |
| 私密备份 | `~/Documents/obsidian-vault-backup` 自动备份 vault，排除了 `.obsidian/plugins/*/data.json`；`.research/` 会被包含 |
| iCloud | 旧缓存目录的文件已被移出本机（`du` 显示 0 B），迁移时需要先下载 |

## 2. 迁移内容

### 2.1 旧解析缓存 → 新存储

对 `.obsidian/plugins/pdf-reading-mode/cache/<sha>-vlm-v1/` 每个目录：

1. 用 `brctl download` 或读取文件触发 iCloud 下载，等待完成。超时先确认是不是 iCloud 下载慢，不直接判失败。
2. 找到 `*_content_list.json`。没有就跳过（例如 Cai 2024 只有 `job.json`，见 2.2）。
3. 把 `*_content_list.json`、`*_content_list_v2.json`、`*_model.json`、`layout.json`、`full.md`、`images/` 复制到 `.research/papers/<sha>/raw/`，保持相对路径。
4. 写 `raw/IMPORTED.json`：来源目录、导入时间、说明哪些成员缺失（旧插件只保存了 json/md/图片）。manifest 中 `mineru.origin = "imported-reader-cache"`，`raw.complete = false`。
5. 旧的 `fallback/`、`fallback-v2/`、`source-tables-v1/` 裁图**不导入**，规范化阶段重新生成到 `derived/`，保证与新规则一致。`result.json`、`performance.json` 不导入。
6. 从 `raw/` 离线规范化，再进入翻译。**全程不上传。**
7. 旧缓存目录保持不动，用于回滚。

### 2.2 只有 `job.json` 的论文（Cai 2024）

`job.json` 里有已上传的 `batchId`。迁移时把它写进新 manifest 的 `mineru.batchId`，阶段设为 `parsing`，流水线先尝试续取。MinerU 若已不再提供该结果（过期或报错），再按正常流程上传。这一篇会计入存量补跑的确认清单。

### 2.3 存量补跑

除上面 3 篇外，约 27 个不同的 PDF 需要首次解析。首次启用时流水线列出篇数和总页数，等你确认。确认前只做导入和离线规范化。

### 2.4 密钥

新插件第一次加载时，如果自己的 SecretStorage 条目为空，就读取旧条目复制过来：

- `pdf-reading-mode-mineru-api-token` → `paper-workbench-mineru-token`
- `pdf-selection-translator-qwen-api-key` → `paper-workbench-dashscope-key`

旧条目不删除（回滚要用）。**你之前在 Codex 对话里贴出过 MinerU Token，请先在 MinerU 后台换一个新 Token，再到新插件设置里保存。**

### 2.5 插件设置

| 旧位置 | 新位置 |
|---|---|
| pdf-reading-mode `fontSize`、`lineHeight`、`scrollDiagnostics` | reader 设置 |
| pdf-reading-mode `positions`（按路径） | 通过 `index.json` 换成按 sha 记录 |
| pdf-selection-translator 的地址、字符上限、超时 | core / selection 设置 |
| codex-note-chat `includeSelection`、`includeOutlinks`、`contextCollapsed`、`window` | agent 设置 |
| codex-note-chat `sessions`（8 个笔记的会话） | 导入消息记录和 `savedCount` 用于显示；线程 id 标记为 Codex 来源，第一次续聊时尝试 `codex exec resume`，失败就新开会话并提示 |
| `system/knowledge/config.json` 的 `codex_path`、`proxy_url`、`forge_model` | agent 设置（CLI 路径、代理、Codex 模型） |
| `system/zotero-sync/config.json` 的 `api_base`、`collection_key`、`collection_name`、`automatic_impact_factor`、`impact_factors`、`supplementary_information` | library 设置 |
| `system/zotero-sync/state.json`、`enrichment-cache.json` | library 状态（插件目录下），保证同步结果与 Python 版连续，不会把已有 PDF 当作新文件重复复制 |

旧配置文件只读取，不修改不删除。

### 2.6 vault 中的文档

在你确认的那一步（阶段 4）一起改：

- vault 根目录 `AGENTS.md`：删除"论文结论必须带 PDF 页码链接"、图片目录、精读相关条款；把"不得把研究方向注入论文生成"改为"`purpose.md` 只用于笔记的 Takeaways、Follow-up ideas 和候选关联三节"；冻结功能的条款移到"冻结"小节，不删除。
- `system/workflows/`：`ingest.md` 改写为新的笔记生成规则；`paragraph-reading*.md` 删除（仓库 `legacy/` 有存档）；冻结功能的工作流文档保留不动。
- `wiki/papers/close-reading/` 里的精读文件、`wiki/papers/images/`、`extracts/papers/`、已有笔记**都不动**。

### 2.7 仓库

- 新仓库 `~/Developer/paper-workbench`。
- `legacy/` 放入：四个旧插件的源码、`system/knowledge/` 和 `system/zotero-sync/` 的 Python、三个旧 skill、相关测试、旧工作流文档。只读归档，不参与构建。
- 推送 GitHub 前先问你：公开还是私有、新建仓库还是沿用旧仓库。旧仓库 README 加指向新仓库的链接。

## 3. 演练（阶段 3）

1. 把 vault 完整复制到非 iCloud 位置（例如 `~/Developer/vault-rehearsal/`）。复制前确认 iCloud 文件已下载到本机，否则副本里会是占位文件。
2. 在副本里停用四个旧插件、启用新插件。**新旧插件不能同时启用**，否则 Zotero 同步和 PDF 工具栏按钮会重复。
3. 用 Obsidian 打开副本，检查：
   - 3 篇旧缓存导入后未上传、离线规范化成功，阅读模式显示正常；
   - Zotero 同步结果与 Python 版一致（manifest diff 只有时间戳），没有重复复制；
   - 存量补跑弹窗的篇数和页数；
   - 中英切换位移测试；
   - 两个适配器各生成一篇笔记（写在副本里）；
   - 旧笔记的 `# 提问` 等受保护块在重新生成后原样保留。
4. 演练中的 MinerU 上传只针对你在确认弹窗里同意的论文；默认不在副本里补跑存量，避免额度消耗两次（副本的 `.research/` 可以在正式迁移时复用，见下）。

**演练产物复用：** 演练中生成的 `.research/papers/<sha>/raw/` 是真实的 MinerU 结果，正式迁移时可以直接复制进真实 vault，不必重新上传。

## 4. 正式上线（阶段 4，你确认后执行）

1. 确认 Obsidian 中没有正在运行的旧流水线任务（`ingest_paused` 本来就是 true）。
2. 在 `community-plugins.json` 中移除 zotero-doc-sync、codex-note-chat、pdf-reading-mode、pdf-selection-translator，加入 paper-workbench。旧插件目录保留。
3. 运行部署脚本复制构建产物到 `.obsidian/plugins/paper-workbench/`。
4. Obsidian 菜单 View → Force Reload。
5. 新插件首次加载：导入密钥、导入设置、导入旧缓存、离线规范化，然后弹出存量补跑确认。
6. 更新 vault 中的 `AGENTS.md` 和工作流文档（2.6）。

## 5. 回滚

任何一步出问题都可以回到旧状态：

1. 在 `community-plugins.json` 中移除 paper-workbench，恢复四个旧插件。旧插件目录、它们的 `data.json`、SecretStorage 旧条目、`system/` 下的 Python 和配置都没有被修改。
2. Force Reload。
3. `.research/` 可以留着（旧插件不读它，Obsidian 不索引它），下次再迁移时复用，不浪费 MinerU 额度。
4. 新插件生成的笔记是普通 Markdown，旧插件可以照常打开；它们的 frontmatter 少了 `extract`、`images_dir`、`paragraph_reading*` 字段，旧流水线把它们当作缺字段的草稿，不会自动重写（`ingest_paused: true`）。
5. vault 中的 `AGENTS.md` 和工作流文档改动前先复制一份到 `system/reports/pre-paper-workbench/`，回滚时复制回去。

## 6. 不做的事

- 不删除 vault 中的 PDF、笔记、`extracts/papers/`、精读文件、图片目录。
- 不删除旧缓存，不为重建缓存删除 MinerU 结果。
- 不批量改写已有笔记的 frontmatter。
- 不自动生成、不重新生成任何笔记。

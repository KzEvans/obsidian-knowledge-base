# Zotero Doc Sync

Obsidian 桌面插件，用于定期运行 `system/zotero-sync/sync_zotero_doc.py`，随后扫描并处理知识任务。

安装时将本目录复制为：

```text
<vault>/.obsidian/plugins/zotero-doc-sync/
```

插件仅保存上次健康检查时间。Zotero collection、本机路径和其他运行参数均由 `system/zotero-sync/config.json` 与 `system/knowledge/config.json` 提供。

SI 首次发现可能需要下载较大的 Supporting Information PDF，因此单次同步允许最多 5 分钟；后续检查由清单中的刷新时间缓存，不会每分钟重复下载。

## 可选逐段精读

常规 Forge Paper Note 草稿会包含两个 Obsidian 复选属性：

- `paragraph_reading`：人工确认这篇论文值得逐段精读；
- `paragraph_reading_figures`：兼容旧笔记的附加裁图开关；原文和当前单元直接相关的图、表、公式裁图始终属于精读流程。

在打开的论文笔记中勾选 `paragraph_reading` 后，插件会自动启动精读并立即显示处理
进度。也可以在命令面板运行“开始或继续当前论文的交互式全文精读”。
插件调用本地 `paper-intensive-reading` skill，把交互日志写到
`wiki/papers/close-reading/`，把原文与相关图像直接从 PDF 裁到论文专属的
`images/<论文>/intensive-reading/Uxx/`。每次只推进一个人机交互阶段。

填写“用户初始理解”后，点击状态栏中的“提交 Uxx 初始理解”按钮；仅填写文字不会
自动推进。提交、继续、提示、解释和合并时均显示后台阶段与进度百分比。还可从命令
面板运行“提交当前精读单元的初始理解”“获取当前精读单元的分级提示”或“查看当前
精读单元的专家解释”。

旧版日志若已停在等待初始理解阶段，状态栏按钮会先显示“更新 Uxx 精读格式”；点击后
只完成原位迁移并保持当前阶段不变。迁移后阅读新版连续裁图与翻译，再填写并提交。

精读日志仅是辅助证据，不能直接执行“审核并整合”。只有单元评分至少 6/8 且无重大
事实错误后，才能运行“合并当前已验证精读单元”。该命令只把验证/修正/非重复增量
连同 PDF 页码写回主笔记；之后仍需对主笔记执行原有审核与整合。

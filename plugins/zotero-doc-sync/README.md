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
- `paragraph_reading_figures`：是否允许把选定裁图保存到论文专属图片目录，默认关闭；不影响图表作为科学证据被阅读。

勾选 `paragraph_reading` 后，在命令面板运行“开始或继续当前论文的交互式全文精读”。
插件调用本地 `paper-intensive-reading` skill，把交互日志写到
`wiki/papers/close-reading/`。每次只推进一个人机交互阶段。还可单独运行“获取当前
精读单元的分级提示”或“查看当前精读单元的专家解释”。日志打开时同样可以执行这些命令。

精读日志仅是辅助证据，不能直接执行“审核并整合”。只有单元评分至少 6/8 且无重大
事实错误后，才能运行“合并当前已验证精读单元”。该命令只把验证/修正/非重复增量
连同 PDF 页码写回主笔记；之后仍需对主笔记执行原有审核与整合。

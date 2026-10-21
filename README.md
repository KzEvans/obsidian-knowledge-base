# Paper Workbench

一个 Obsidian 桌面插件，把论文从 Zotero 带到可读、可译、可写笔记：

- Zotero 同步：镜像 Doc collection 及子文件夹里的 PDF，维护索引、BibTeX、SI 和影响因子。
- 解析与翻译：PDF 自动上传 MinerU 云端 VLM 解析，规范化后用 Qwen-MT 逐段翻译，结果保存在 vault 的 `.research/`。
- 阅读模式：双栏论文重排为单栏，中英对照切换时页面位置不变；英文状态下可划线翻译。
- 笔记：由你手动发起生成，可选 Codex CLI 或 Claude Code CLI；笔记问答窗口。

设计文档见 [docs/](docs/)。旧插件与 Python runner 归档在 [legacy/](legacy/)。

## 开发

需要 Node 26.12.0 和 pnpm 12.14.0。

```sh
pnpm install
pnpm check      # 类型检查 + lint + 测试 + 提交前扫描
pnpm build
pnpm deploy -- "<vault 路径>"
```

提交前钩子：`git config core.hooksPath .githooks`。

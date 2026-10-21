# Paper Workbench：开发约定

Obsidian 桌面插件。设计文档在 `docs/`，开始工作前先读 `docs/architecture.md` 和 `docs/contracts.md`。

## 边界

- 每个工作会话只改自己负责的目录（任务说明里写明）。
- `src/core/` 和 `src/main.ts` 已冻结。需要改接口时，停下来在会话里提出，由主会话统一修改。
- 模块只能依赖 `src/core/`。规则由 `eslint.boundaries.mjs` 强制，`tests/boundaries.test.ts` 有测试。
- `legacy/` 是只读归档，可以查阅旧实现，不要修改，也不要从这里 import。

## 质量

- 提交前运行 `pnpm check`（类型检查、lint、测试、提交前扫描），必须全部通过。
- TypeScript strict + `noUncheckedIndexedAccess`，不用 `any`；Obsidian / pdf.js 缺类型就加到 `src/core/obsidian-internal.d.ts`（通过主会话）。
- 每个 bug 先写能复现的测试，再修。
- 不加用不到的抽象和配置项。
- 主线程单次占用不超过 50 ms，长任务分片让出。

## 测试

- `pnpm test` 用 `node --test` + `tsx`；`tests/setup.ts` 提供 `window` 和 `obsidian` 运行时桩（`tests/stubs/obsidian.ts`，需要时扩充）。
- DOM 测试用 `linkedom`。
- 真实论文只从本机读取：`PAPER_WORKBENCH_VAULT="<vault 路径>" pnpm test`。论文、快照、结果都不进仓库。

## 安全

- 密钥只经 `context.secrets` 读写，日志一律经 `context.log`（自动脱敏）。
- 不在代码、测试、提交信息里写入任何真实密钥、vault 绝对路径或论文内容。
- 不删除 vault 中的 PDF、笔记、旧解析结果；不重新上传已有 MinerU 结果。

## 沟通

用中文和用户沟通。

# 阅读模式端到端验收

## 中英切换位移（architecture §6.2）

在真实 Obsidian 里打开论文的阅读模式，对每篇论文 × 每种视图宽度 × 至少 20 个滚动位置：
记录视口顶端那个阅读块（以及视口里第一个双层块）到视口顶端的距离，切到中文再读一次，
切回英文再读一次。任何一次变化超过 1 px、块消失或滚动位置改变都算失败。
同时记录每次打开阅读模式的耗时（每篇第一次为冷启动，后面为内存缓存）。

前提：插件已部署并启用；被测论文已经有 `document.json` 和 `translation.zh.json`
（流水线至少翻译了一部分，否则中文按钮置灰，该论文记为错误）。

### 1. 构建脚本

在仓库根目录：

```bash
pnpm exec esbuild tests/e2e/shift-acceptance.ts --bundle --format=cjs --platform=node --external:obsidian --outfile=tests/e2e/results/shift-acceptance.cjs
```

`tests/e2e/results/` 已被 gitignore，脚本和结果都不进仓库。

### 2. 在 Obsidian 开发者控制台运行

`Cmd+Option+I` 打开开发者工具，在 Console 里（把 `<repo>` 换成本仓库的绝对路径）：

```js
const shift = require('<repo>/tests/e2e/results/shift-acceptance.cjs');
const result = await shift.run(app);
console.table(result.table);
console.table(result.timings);
result.pass;
```

默认从 `.research/index.json` 取前 3 篇有译文的论文，宽度 420 / 600 / 900 px，每个宽度 24 个滚动位置。
也可以指定：

```js
await shift.run(app, {
  papers: ['sources/literature/pdf/<collection>/<file>.pdf', '…', '…'],
  widths: [420, 600, 900],
  positions: 24,
  settleMs: 1500,   // 打开后等待 MathJax 与图片稳定的时间
});
```

脚本会为每篇论文新开一个标签页，逐个宽度打开、测量、关闭阅读模式，最后关闭标签页。
运行期间不要操作 Obsidian。

### 3. 结果

- `run()` 返回 `pass`、`maxDeltaPx`、`failures`、`table`（每篇每个宽度的最大位移）、`timings`（打开耗时）和结果文件路径 `file`。
- 完整结果写到 `tests/e2e/results/shift-<时间>.json`：`summary`（是否通过、最大位移、失败位置）、
  `timings`（打开耗时）、`runs`（每个位置的三次读数）。结果里只有文件名和块 id，没有正文。

验收标准：`summary.pass === true`，即 3 篇 × 3 种宽度 × ≥ 20 个位置全部 ≤ 1 px 且滚动位置不变。

## 首屏性能

已缓存的 15 页论文从打开到首屏应 ≤ 300 ms。两种看法：

- 上面脚本的 `timings` 中 `cached: true` 的 `openMs`（点击按钮到阅读层激活）。
- 在设置「阅读 → 滚动性能诊断」开启后打开阅读模式：插件目录下 `diagnostics/reader-<sha 前 12 位>.json`
  的 `open` 字段记录 `loadMs`、`renderMs`、`firstScreenMs`（点击到首屏绘制）和是否命中内存缓存；
  控制台（Verbose 级别）也会打印一行“阅读模式首屏 … ms”。

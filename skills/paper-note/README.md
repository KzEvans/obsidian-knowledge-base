# skills/paper-note

论文笔记的 skill、确定性 lint 和评测脚本。本目录不包含任何论文、笔记或评测结果。

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 模板（9 节）、各节写法、写作规则 |
| `references/plain-writing.md` | “说人话”规则，参考 Humanizer-zh 重写（出处见根目录 `THIRD_PARTY_NOTICES.md`） |
| `references/banned-phrases.md` | 禁用词和对冲词表；skill 和 lint 共用这一份 |
| `index.ts` | `PAPER_NOTE_SKILL` = SKILL.md + 两个 references |
| `output.ts` | 生产与评测共用的只读 JSON 候选 schema 和校验 |
| `fulltext.ts` | `fullText()`：交给 CLI 的规范化全文；格式只在这里改，agent 和评测共用 |
| `lint.ts` | `lintNote()`，规则和阈值常量都在文件开头 |
| `lint-cli.ts` | 命令行检查：`pnpm exec tsx skills/paper-note/lint-cli.ts [--json] <note.md> ...` |
| `eval/` | 评测脚本（下文） |

## lint 规则

| rule | 检查 | 阈值 |
|---|---|---|
| `sections` | 9 个二级标题齐全、各出现一次、没有多余的二级标题 | — |
| `section-order` | 顺序与模板一致 | — |
| `page-link` | 没有 `#page=` | 0 |
| `embed` | 没有 `![[…]]`、`![](…)` | 0 |
| `banned-phrase` | 禁用词表中的词句 | 0 |
| `hedges` | 对冲词（可能、或许……）全文合计 | `MAX_HEDGES` = 12 |
| `bold` | 每节加粗处数 | `MAX_BOLD_PER_SECTION` = 2 |
| `bold-label` | 行首 `**xx：**` 式的加粗小标题 | 0 |
| `heading-skip` | 标题层级不跳级 | — |
| `length` | 正文字数（不含 frontmatter、一级标题、摘要翻译） | `MIN_LENGTH`–`MAX_LENGTH` = 1500–6000 |
| `long-sentence` | 单句字数（`[[链接]]` 算一个词） | `MAX_SENTENCE_LENGTH` = 100 |
| `evidence-numbers` | 「论点与证据」每行（一条论点）的数字个数（图、表、式、参考文献编号不算） | `MAX_EVIDENCE_NUMBERS_PER_ITEM` = 2 |

字数按中文字处理软件的习惯算：每个汉字、全角标点算 1，每个连续的英文单词或数字算 1。受保护区域（`人工复核`、`Human Review`、`提问` 节，`user-notes` 和 `intensive-reading` 块）由你维护，lint 不检查。

改禁用词：编辑 `references/banned-phrases.md` 的列表即可，`……` 表示同一句中间的任意文字。

## 评测

输入只从本机读，输出写到仓库外，**不提交**。

```bash
export PAPER_WORKBENCH_VAULT="<vault 路径>"
export PAPER_NOTE_EVAL_CACHE="<vault>/<配置目录>/plugins/pdf-reading-mode/cache"
export PAPER_NOTE_EVAL_OUT="$HOME/Developer/paper-workbench-eval"   # 可省略，这是默认值
export PAPER_NOTE_EVAL_SETTINGS="<vault>/<配置目录>/plugins/paper-workbench/data.json"   # 用插件里设置的模型和思考强度
pnpm exec tsx --import ./tests/setup.ts skills/paper-note/eval/run.ts --round r1
pnpm exec tsx --import ./tests/setup.ts skills/paper-note/eval/blind.ts --round r1
```

`run.ts` 的选项：`--adapters codex,claude`、`--papers <附件 key,…>`、`--inputs-only`。

流程：

1. 评测集是 `eval/papers.ts` 里的三篇（按 Zotero 附件 key 指定）。用 vault 的 `zotero-doc.json` 找到 sha 和 PDF，从旧阅读插件的 MinerU 缓存离线运行 core 的 `derive()`（`eval/fulltext.ts`），再用 `fulltext.ts` 的 `fullText()` 生成规范化全文 `inputs/<key>/paper.md`（无页码，带图表题注）。**不上传、不调用 MinerU**。摘要翻译留占位。
2. 每篇、每个适配器建一个工作区 `runs/<round>/<key>/<adapter>/work/`：全文、元数据、`purpose.md`、vault 标题清单和 `wiki/` 的副本（去掉这篇论文的旧笔记）。模型只读副本，不获得文件写权限。
3. 通过生产共用的适配层，把 `PAPER_NOTE_SKILL` 与任务说明交给只读 `codex exec` 或 `claude -p`，返回 JSON 的 noteMarkdown 字符串，由程序保存 `note.md`。
4. 对 `note.md` 跑 lint，写 `lint.json`；整轮汇总在 `runs/<round>/summary.json`。
5. `blind.ts` 把每篇新笔记和 vault 里同一 `zotero_attachment` 的旧笔记并排，随机标 A/B，写到 `blind/<round>/P<n>/`（`compare.html` 左右并排），答案单独在 `blind/<round>/answers.json`。旧笔记去掉 frontmatter、一级标题、人工复核节，图片嵌入换成“[图片]”；新笔记的摘要占位换成一句说明。

看什么：

- lint 是否通过，失败集中在哪条规则；
- 字数是否落在建议范围，哪一节最长；
- 人工读：只看研究背景末两句和思考路径，能否复述问题、答案和论文每一部分的作用；前人不足是否具体；思考路径和论点台账有没有把同一个实验讲两遍；台账每条是否有条件、证据类型和图表号；Takeaways 是否空泛；
- 知识库：「相关笔记」的链接是否都存在于 vault；「实体」的名字是否复用了 vault 里已有的叫法，frontmatter 四个列表是否与之一致；
- 是否出现页码、图片、免责声明复读、加粗小标题。

## 迭代记录

记录 skill 每轮改了什么、为什么（不含论文内容）。评测于 2026-10-21/22，Codex 用本机 `~/.codex/config.toml` 的默认模型，Claude 为 claude-opus-5-5；每篇每个适配器约 1–2.5 分钟。

| 轮次 | Codex（3 篇） | Claude（3 篇） |
|---|---|---|
| r1 | 全部通过，2076–2239 字 | 3 篇 `evidence-numbers` 超标（3.0–4.0 个/100 字），1 篇 3059 字超长 |
| r2 | 全部通过，2189–2291 字 | 2 篇 `evidence-numbers`（3.4、4.4），1 篇 3038 字 |
| r3 | 全部通过，2055–2287 字 | 全部通过，2555–2687 字 |
| r4 | 全部通过，2706–3183 字 | 未运行 |
| r5 | 全部通过，2794–3090 字 | 未运行 |
| r6 | 全部通过，3160–3245 字 | 未运行 |
| r7 | 全部通过，3128–3598 字 | 未运行 |

r4（2026-10-23）和 r5–r7（2026-11-10）用插件设置里的 Codex 模型和思考强度。

- **r1 → r2**：Claude 在「论点与证据」里堆实验条件和测量值，「本文内容与创新点」的概述段也逐个列性能参数；Codex 每条论点末尾都附一句“不能据此……”，近于防御性叙述。改动：概述段限 150 字、2–3 个关键数字；论点每条最多一个数字；只在证据确有短板的条目写一句短板，并要求指出最可靠和最弱的结论；给出各节篇幅参考。
- **r2 → r3**：Claude 仍把模量范围、转化率等条件取值写成数字。改动：明确“条件和对照的取值也算数字”，告知 lint 的密度阈值；自查清单加上数字和总字数两项。r3 两个适配器全部通过 lint，人工阅读未见质量下降。
- 三轮都没有出现页码、图片嵌入、禁用词、加粗小标题和层级跳级；候选关联中的 `[[链接]]` 全部能在 vault 标题清单中找到。
- **r4 → r5**：r4 的「作者的思考路径」和「论点与证据」合计占正文四成，同一组实验在两节各讲一遍；`purpose.md` 为空时 Takeaways 和 Follow-up 仍占两成；vault 没有概念页，三篇的 frontmatter 四个列表全空。改动：笔记分成给人读的叙述和给知识库用的台账两层。研究背景末两句固定为问题和一句话答案；思考路径改成论证骨架，每步对应论文的一部分并说明它为什么引出下一步，不写测量数值；论点与证据改成“结论、条件、证据类型（图表号）”三段，取消保留句配额，每条最多两个数字（lint 从全节密度改为按行计数）；`purpose.md` 为空时 Takeaways、Follow-up 各最多 2 条；候选关联分「相关笔记」和「实体」，实体不论页面是否存在都写成链接并进 frontmatter，命名先复用 vault 已有叫法；告知模型它看不到图像和 SI，缺失信息写“正文未见”。
- r5 结果：三篇台账各 6 条，全部带条件、证据类型和图表号；思考路径占 32–34%，不含测量数值；Takeaways 加 Follow-up 降到 11–12%；每篇 6 个实体，frontmatter 与「实体」小节一致，三篇分别复用 vault 已有名字 0、1、5 个；「相关笔记」链接全部存在；前六节的数字都能在全文中找到。
- **r5 → r6**：r5 的保留句从台账扩散到了思考路径（每篇 3–4 处），同一句“缺少直接测量”和同一个实验条件在三四个节里重复出现。繁琐来自重复、堆数据和防御性语言，不来自字数。改动：去掉目标字数和各节篇幅，思考路径不限句数；写明每类信息的固定位置，别的节不重新解释；保留意见只写在台账里，每个结论一次；创新点每个一句话；台账的「条件」只写适用范围。r6 三篇的思考路径里没有保留句，全篇保留句从 6–9 处降到 1–5 处，除转述前人卡点的以外都在台账里；思考路径占 37–44%。新起的实体名在两轮之间不稳定（如“瞬态网络”和“瞬态聚合物网络”），稳定的只有复用 vault 已有名字的那些。
- **r6 → r7**：r6 的思考路径常只给结论不给道理，模型和表征方法直接出现而不说明用途。改动：思考路径写深机理（第一步讲成因果链）和推理（每步写出从结果到结论的逻辑，方法第一次出现时用半句交代用途）；写深以原文为准，原文只给结论的照实写“作者把 X 解释为 Y”，不替作者补道理或设想别的解释，模型自己补的一步标“（推断）”，全节最多两处。同时把 r5、r6 期间写进 skill 的例子换掉：其中几个取自评测论文，会抬高那两轮“复用已有名字”的数字。r7 三篇的思考路径占 43–47%，没有保留句，没有标“（推断）”的句子；逐句对照了其中一篇的思考路径，各步的因果说法都能在原文找到对应段落，原文只引文献、没讲道理的地方，笔记也只写了结论。

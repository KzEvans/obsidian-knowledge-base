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
| `evidence-numbers` | 「论点与证据」每 100 字中的数字个数（图、表、式、参考文献编号不算） | `MAX_EVIDENCE_NUMBERS_PER_100` = 2 |

字数按中文字处理软件的习惯算：每个汉字、全角标点算 1，每个连续的英文单词或数字算 1。受保护区域（`人工复核`、`Human Review`、`提问` 节，`user-notes` 和 `intensive-reading` 块）由你维护，lint 不检查。

改禁用词：编辑 `references/banned-phrases.md` 的列表即可，`……` 表示同一句中间的任意文字。

## 评测

输入只从本机读，输出写到仓库外，**不提交**。

```bash
export PAPER_WORKBENCH_VAULT="<vault 路径>"
export PAPER_NOTE_EVAL_CACHE="<vault>/<配置目录>/plugins/pdf-reading-mode/cache"
export PAPER_NOTE_EVAL_OUT="$HOME/Developer/paper-workbench-eval"   # 可省略，这是默认值
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
- 人工读：前人不足是否具体、思考路径是否成因果链、论点是否都指向图表、Takeaways 是否空泛、候选关联是否真的存在于 vault；
- 是否出现页码、图片、免责声明复读、加粗小标题。

## 迭代记录

记录 skill 每轮改了什么、为什么（不含论文内容）。评测于 2026-10-21/22，Codex 用本机 `~/.codex/config.toml` 的默认模型，Claude 为 claude-opus-5-5；每篇每个适配器约 1–2.5 分钟。

| 轮次 | Codex（3 篇） | Claude（3 篇） |
|---|---|---|
| r1 | 全部通过，2076–2239 字 | 3 篇 `evidence-numbers` 超标（3.0–4.0 个/100 字），1 篇 3059 字超长 |
| r2 | 全部通过，2189–2291 字 | 2 篇 `evidence-numbers`（3.4、4.4），1 篇 3038 字 |
| r3 | 全部通过，2055–2287 字 | 全部通过，2555–2687 字 |

- **r1 → r2**：Claude 在「论点与证据」里堆实验条件和测量值，「本文内容与创新点」的概述段也逐个列性能参数；Codex 每条论点末尾都附一句“不能据此……”，近于防御性叙述。改动：概述段限 150 字、2–3 个关键数字；论点每条最多一个数字；只在证据确有短板的条目写一句短板，并要求指出最可靠和最弱的结论；给出各节篇幅参考。
- **r2 → r3**：Claude 仍把模量范围、转化率等条件取值写成数字。改动：明确“条件和对照的取值也算数字”，告知 lint 的密度阈值；自查清单加上数字和总字数两项。r3 两个适配器全部通过 lint，人工阅读未见质量下降。
- 三轮都没有出现页码、图片嵌入、禁用词、加粗小标题和层级跳级；候选关联中的 `[[链接]]` 全部能在 vault 标题清单中找到。

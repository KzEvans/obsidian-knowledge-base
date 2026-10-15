# Obsidian Knowledge Base

一套将 Zotero 文献、Obsidian 实验笔记与 Codex 串联起来的本地、自生长知识库工具。

本仓库只包含插件、自动化脚本及流水线所需 Codex Skills，不包含任何 PDF、笔记正文、对话记录、运行日志、Zotero 条目或本机配置。

## 目录

- `plugins/codex-note-chat/`：在当前笔记中打开可移动、八方向缩放的紧凑问答窗，按需加入来源 PDF、选中文本、出链和本地相关知识片段，并支持人工复核及写回对话。
- `plugins/zotero-doc-sync/`：定期同步 Zotero collection，并驱动知识任务队列。
- Doc 子分类递归映射到 `sources/literature/pdf/<分类>/` 和 `wiki/papers/<分类>/`；已有论文迁移时保留正文、图片与任务状态，并更新链接。只整理目录时使用同步器的 `--organize-only`，新论文暂存等待显式生成。
- `knowledge-base/system/zotero-sync/`：自动发现、校验并缓存 PDF Supporting Information，供 Forge Paper Note 按需核对。
- `plugins/pdf-selection-translator/`：在 Obsidian PDF 阅读器中翻译选中文本；包含 TypeScript 源码和构建产物。
- `knowledge-base/`：Zotero PDF 镜像、PDF 文本提取、草稿生成、人工审核、知识整合和健康检查脚本。
- `knowledge-base/system/workflows/knowledge-context.md`：本地跨来源检索、关联与整理线索；`system/knowledge/purpose.md` 是用户维护的空白研究目标模板。
- `skills/forge-paper-note/`：常规论文笔记生成 Skill，以及确定性的提取、图片、审计与保存脚本。
- `skills/paper-reading/`：保留的上游 Mode A Skill，不修改其原始版本。
- `skills/paper-intensive-reading/`：基于 Mode A 改造的全文逐段原文/翻译交替阅读、PDF 配图裁切、交互验证与显式合并 Skill。
- 可选逐段精读：人工勾选后自动启动；把交互过程隔离到 `wiki/papers/close-reading/`，逐段交替显示提取原文与翻译，并把相关 PDF 配图裁到论文专属 `images/.../intensive-reading/Uxx/`；普通精读阶段不修改自动论文笔记正文。

## 安装

1. 将需要的插件目录复制到 `<vault>/.obsidian/plugins/`，并在 Obsidian 中启用。
2. 将 `knowledge-base/` 内的内容复制到 vault 根目录。
3. 运行 `python3 scripts/install-bundled-skills.py`，把仓库内的三个 Skill 安装到 `$CODEX_HOME/skills/`；安装器遇到已有同名目录会停止，不会覆盖。
4. 分别复制两个 `config.example.json` 为 `config.json`，填写本机路径和 Zotero collection 名称。
5. 确保 Zotero 已开启本地 API，并安装 MinerU、`pdftotext` 与 Codex CLI。MinerU 是主解析器，`pdftotext` 是自动回退。
6. 在 vault 中创建 `sources/literature/`、`笔记/实验笔记/`、`extracts/papers/`、`wiki/papers/images/` 和其他 `wiki/` 所需目录。

推荐使用独立 Python 3.12 环境安装 MinerU，避免影响系统 Python：

```bash
brew install uv
uv venv --python 3.12 /path/to/mineru-environment
uv pip install --python /path/to/mineru-environment/bin/python -U "mineru[all]"
/path/to/mineru-environment/bin/mineru --version
```

首次实际解析会下载模型，请预留足够磁盘空间。把独立环境里的 `mineru`
绝对路径填入 `system/knowledge/config.json` 的 `mineru_path`。

手动验证：

```bash
python3 system/zotero-sync/sync_zotero_doc.py
python3 system/knowledge/run_pipeline.py scan
python3 system/knowledge/run_pipeline.py status
python3 system/knowledge/run_pipeline.py ingest-next
```

## 数据边界

- `sources/literature/pdf/` 和实验笔记是原始资料，流水线只读取，不覆盖。
- 未审核草稿只进入 `wiki/papers/` 或 `wiki/experiments/`。
- 整合需要 `status: reviewed`、`reviewed: true` 和匹配当前内容的审核指纹；剩余校验警告必须由人明确接受。请在对话插件中完成审核，整合按钮不再自动授予审核。
- 所有论文声明应保留来源 PDF 页码链接；不确定页码时必须标记待核对。
- 论文属性自动获取并保留影响因子、统计年份、官方来源和核验时间；缺失时写 `null`，不以其他引用指标替代。
- `config.json`、`data.json`、队列状态、日志和生成内容已由 `.gitignore` 排除。

## 本地相关知识与关联整理

问答窗中的“加入相关知识”默认关闭。开启后，runner 按本轮问题和当前笔记
检索本地相关笔记或知识页，最多返回 4 个结果；问答加入相关章节片段，保留
原页码、来源、关联理由及审核状态，总量不超过 16,000 字。草稿只供线索，
关键结论仍需核对原始 PDF。人工复核只用当前笔记与其来源，不混入其他论文。

命令行入口（在 vault 根目录运行）：

```bash
python3 system/knowledge/run_pipeline.py knowledge-context --question '需要比较的问题' --note 'wiki/papers/分类/当前笔记.md' --limit 4
python3 system/knowledge/run_pipeline.py knowledge-map --report
python3 system/knowledge/run_pipeline.py compare-evidence --question '需要比较的问题' --note 'wiki/papers/分类/当前笔记.md' --report
python3 system/knowledge/run_pipeline.py maintain-concepts --report
python3 system/knowledge/run_pipeline.py maintain-questions --report
```

关联报告写入 `system/reports/local-knowledge-map.md`，列出本地链接、共享实体、
重名/未解析链接及重复声明等整理线索，不调用模型或自动修正文献与规范页。
关联不表示证据互相支持或科研新颖性。在 Obsidian 命令面板运行“查看知识关联与整理线索”即可生成并打开报告；
检索 JSON 契约和报告规则见 [knowledge-context.md](knowledge-base/system/workflows/knowledge-context.md)。

命令面板另有“生成跨论文证据对比”“查看同义概念整理建议”和“更新研究问题整理报告”。
比较命令先输入问题，再生成保留各源声明、条件与页码的报告；另外两项报告只检查显式名称映射和问题的本地证据覆盖。
三项均不调用模型、不修改规范页，生成暂停时仍可使用。草稿仅供线索，正式跨来源对比须有至少两项当前有效审核的独立主来源；支持、限定或矛盾仍由证据审阅判定。
用户维护的 `system/knowledge/concept-aliases.json` 及概念页 `aliases` 提供显式同义映射，报告不自动合并或删除。
详细规则见 [knowledge-maintenance.md](knowledge-base/system/workflows/knowledge-maintenance.md)。

用户可填写 [purpose.md](knowledge-base/system/knowledge/purpose.md) 中的研究目标。
模板不预填个人方向；普通问答和审核后整合最多读取 6,000 字用于聚焦。
研究目标、关联检索和报告不进入论文笔记生成流程。

审核后的科学整合在候选工作区执行：模型只更新七类规范知识目录，保留声明标记、
源笔记及原 PDF 页码/实验位置。runner 校验候选与并发编辑后发布，确定性更新
源笔记状态和 `wiki/index.md`；源正文保持原样，规范页指向源笔记的链接提供
Obsidian 反向导航。操作规则见 [integrate.md](knowledge-base/system/workflows/integrate.md)。
多源整合使用 runner 提供的当前已审核来源声明包，每条声明保留自身来源、条件与页码；比较/问题页更新保留人工状态并写明下一步核验，不自动判断科研新颖性。

本地 Python 检索独立适配了固定上游源码中的题名/短语匹配、查询命中种子的一跳图扩展和 Adamic–Adar 共享邻居降权。
图扩展限制种子和结果名额，常规 top 4 至多加入一个一跳结果；关系分本身不产生查询种子。
审核后整合仍由现有一次模型调用生成完整候选，再由 runner 合并 `sources/tags/related/aliases`、恢复原身份与问题状态元数据、删除完全重复的证据块并验证。
旧声明的条件保持原样；新纠正需要新声明 ID。失败保留现有页与候选，不增加第二次归并模型，也不退回直接覆盖。
固定源码与独立适配说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

可用 `scripts/evaluate-knowledge-retrieval.py` 对预先定义的私有相关性案例运行受控基线/当前模块比较，固定 top 4，输出 Recall@4、首命中、MRR@4、全部排名及零匹配负例结果。
实际私库案例放 runtime；公开文档只提供通用格式。报告保留无改善、退步和负例失败，检索相关性标注不代表用户金标准或论文结论验证。用法见 `knowledge-context.md`。

## PDF 解析

论文默认由 MinerU 解析双栏版面、公式、表格、图像和扫描页。流水线读取
MinerU 的 `content_list.json`，使用 `page_idx` 重新生成带 `## Page N` 的
Markdown，供 Forge Paper Note 保留可核查的 PDF 页码引用；MinerU 的完整图像缓存保存在
`extracts/papers/assets/`。真正写入论文笔记的裁图按论文隔离存入
`wiki/papers/images/<论文笔记名>/`，不会与其他论文共用目录。如果 MinerU 缺失、超时、失败或输出不足，流水线会
自动回退到 `pdftotext -layout`。只有两种方式都无法取得足够文本时，任务才会
进入 `needs_ocr`。

## Forge Paper Note 论文阅读

论文摄取只调用本仓库随附的 `forge-paper-note` skill，并继续遵守本知识库的来源链接、草稿审核、图片隔离和整合规则。安装后、首次处理论文前验证 skill：

```bash
python3 scripts/check-forge-paper-note.py
```

仓库源文件位于 `skills/forge-paper-note/`，运行安装器后生效副本位于 `$CODEX_HOME/skills/forge-paper-note/`。
在 `system/knowledge/config.json` 中把 `forge_python_path` 设为 Python 3.10+ 的绝对路径。
该环境还需安装 PyMuPDF 与 Pillow；运行检查时可用 `--python /path/to/venv/bin/python` 指定同一解释器。保留虚拟环境调用路径，不要替换为其符号链接指向的基础解释器。
该 skill 复用了 DeepPaperNote 的确定性单论文流水线，并吸收了 PaperForge 的研究推理思想；两者均在下方保留来源说明。

单篇 Forge 笔记生成上限为30分钟墙钟时间，包含休眠、MinerU 提取、计划、撰写和校验。
计划先落盘，正文逐节原子保存，再补可选配图；10分钟没有当前阶段的计划/正文文件更新就停止。
未完成正文留在候选工作区，不能作为完整笔记发布；完整草稿再由 runner 执行表格规范化和三项确定性校验。
自动模型修复默认关闭，校验警告保留给人工复核或显式修复命令。
表格中的 Obsidian 链接会自动转义分隔符并缩短为页码别名，全空列会被删除；前人工作
表使用可点击的紧凑引用标签，不再逐行塞入完整参考文献和重复核验声明。前人工作、创新背景和后续方向只依据当前
论文正文及其参考文献表进行转述，不联网检索或打开被引论文；笔记会明确标注
“仅依据本文转述，未独立核验”，后续方向的新颖性状态保持为 `unresolved`。

### 中断、重试与内容保护

- 模型只写候选工作区；保留原笔记快照，发布前核对原文是否被同时编辑。
  有冲突时保留候选稿，原笔记不替换。位置可通过 `status` 输出或队列的
  `forge_candidate_path` 找到。
- `# 提问`、人工复核区、`user-notes` 和已合并精读块由 runner 保留。
  同名图片内容改变时另存带内容版本的文件，不覆盖旧图片。
- 计划和撰写是独立调用。显式重试复用同一来源版本的计划、未完成正文、已裁图片及提取缓存；原笔记被人工编辑后不会恢复旧候选正文。
- `forge_token_budget: null` 取消论文和各阶段的 token 限制，并显式关闭该子任务的 CLI rollout budget；仍记录可观测用量。
  设置正整数可重新启用总预算和阶段配额。预算统计不是精确计费额度；30分钟期限与10分钟产物停滞保护独立保留。
  仅论文子任务关闭无限重连、持续目标和子代理；连续重连超过1次由 runner 中止，失败不自动重新入队。
- 模型调用前再次核对已有主笔记，完成凭据保存在本机缓存而非 iCloud；队列回退不会自动重做同一版本。
  凭据存在但笔记缺失时进入 `needs_reconciliation`，先恢复文件或明确选择重新生成。
- 命令面板新增“只校验并修复当前 Forge 草稿”，不重做全文分析。
  命令行对应 `repair --note <相对路径>`，然后 `ingest-next --note <同一路径>`。
- 队列写入和扫描使用同一台 Mac 的文件锁；请只指定一台 Mac 执行后台流水线。
  iCloud 负责同步内容，不是多设备任务调度器。运行报告和候选稿仍保留在
  `system/runtime/` 便于排查，且排除在私密备份之外。
- 知识整合使用稳定论文身份和源声明 ID；精读日志、重复附件不计作独立论文。
  语义相同与科学矛盾仍由审核后的整合阶段判断，不能仅凭哈希判定。

### 元数据补全与备份

普通同步只复制 PDF、发布元数据并入队。插件另有每小时 SI/JIF 补全任务，
手动调用 `python3 system/zotero-sync/sync_zotero_doc.py --enrich`；辅助任务使用
独立缓存和锁，不占用主 PDF 同步。JIF 需统计年份、同一期刊和官方页面摘录，
缺少年份或只有通用目录链接不能作为新验证值。SI 的 `fetch_error` 与
`not_found` 分开记录，前者保留失败原因并较早重试。

可复用备份工具为 `scripts/backup_vault.py`，在**独立私密 Git 仓库**内使用：

```bash
python3 scripts/backup_vault.py --source /path/to/vault --repository /path/to/private-backup
python3 scripts/backup_vault.py --repository /path/to/private-backup --verify-only
```

备份目录必须自备 `.backup-excludes` 排除凭据、插件私有状态、队列和 runtime。
工具先创建并核验候选快照，遇到 iCloud 占位文件或大量删除会停止；保存文件哈希清单。
即使没有新变化，也会重试未推送的提交，并核对远端 HEAD。恢复时先克隆至新目录并
运行 `--verify-only`，不要覆盖使用中的 vault。配置本机路径后运行 `scan`，已有主笔记
会恢复其 drafted/reviewed/integrated 状态，不因队列未备份而全部重复生成。

## 可选交互式全文精读

每篇常规论文笔记会显示两个复选属性：`paragraph_reading` 用于人工选择值得
精读的论文；勾选后插件自动启动并显示当前阶段、已用时间和后台输出间隔。无法测量完成比例的 AI 阶段使用不定进度条，不显示估算百分比。`paragraph_reading_figures`
保留为旧笔记的附加裁图开关，不控制当前单元直接相关的图表裁图。也可以在
Obsidian 命令面板手动执行“开始或继续当前论文的交互式全文精读”。未勾选的论文
不会被后台自动精读。

精读日志存放于 `wiki/papers/close-reading/<主论文笔记文件名>`。新流程取消开场
“阅读契约”，把全文组织为通常 4–8 个连续、互不重叠的 `Uxx` 单元，并将背景、
定义和过渡段并入相邻单元。每个单元按多个 `Pxx` 依次展示“一段提取原文 → 紧跟
该段翻译”，不再重复显示“原文”“翻译”标签；若该段有直接相关的图、表或公式，才在这组原文与翻译后插入从 PDF
裁切的图片。单元最后只给一次原文位置和交互，不写 AI 判断的单元作用或关系。
普通原文保持可搜索 Markdown；配图存放在
`wiki/papers/images/<论文笔记名>/intensive-reading/<Uxx>/`。

首次呈现单元后状态停在 `awaiting_initial_analysis`。填写初始理解并不会自动推进，
必须点击 Obsidian 状态栏中的“提交 Uxx 初始理解”按钮；空内容会被拒绝并给出修改
提示。后台随后按 AI 导师问题 → 可选分级提示 → 专家解释 → 用户重构 → 0–8 分评分
推进，每次调用均显示真实阶段与等待时间。得分至少 6/8 且不存在重大事实错误时，该单元
才进入待合并状态。人工文本始终原样保留。

已有旧版精读日志若仍停在初始理解阶段，先运行一次“开始或继续当前论文的交互式
全文精读”：该次只把当前单元刷新为逐段原文/翻译交替格式，不推进阶段，也不改写
人工内容。看到新版段落对后再填写并点击提交。

主论文笔记是该论文唯一允许进入自生长知识库的来源；逐段精读笔记标记为
`integration_role: auxiliary`，不能单独审核整合。在普通“继续/提示/解释”阶段，
流水线会校验主论文笔记正文没有变化。只有人工运行“合并当前已验证精读单元”后，
才把验证结论、修正或非重复增量连同原 PDF 页码写入主笔记的“精读验证与增量”层。
完成全文前不会产生规范知识；全文完成后也只生成候选，仍需审核主笔记并运行原有
整合命令，才会影响规范知识页。

PDF 处理继续使用 MinerU 生成逐页 Markdown、公式、表格和图注导航并缓存在
`extracts/papers/`；精读原文直接使用该缓存中的可搜索文本，并与翻译逐段交替。
图、表、公式仍由 `crop_pdf_region.py` 从原 PDF 直接裁切，不复制 MinerU 图像。
MinerU 失败时可回退到 `pdftotext`，日志会保留实际解析器。

本功能的新 skill 位于 `skills/paper-intensive-reading/`，是在保留原始
[Kingslayer-bot/paper-reading-skill](https://github.com/Kingslayer-bot/paper-reading-skill)
Mode A 的同时进行的独立改造。安装后生效副本位于
`$CODEX_HOME/skills/paper-intensive-reading/`。验证命令：

```bash
python3 scripts/check-paper-intensive-reading.py
```

## 致谢与引用

本项目使用本地 Forge Paper Note 流程；可选逐段精读的新 skill 基于
[Kingslayer-bot/paper-reading-skill](https://github.com/Kingslayer-bot/paper-reading-skill)
的 Mode A 改造。Forge 的研究审计方法参考了 Feijiang Han 维护的
[PaperForge](https://github.com/FeijiangHan/PaperForge)，确定性论文与图片流水线源自
[DeepPaperNote](https://github.com/917Dhj/DeepPaperNote)。如果在研究或项目中使用该流程，请保留相应上游引用：

相关 Skill 的固定上游版本、MIT 许可证位置和完整 BibTeX 见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

本地知识检索与规范候选归并的算法还独立适配了
[nashsu/llm_wiki](https://github.com/nashsu/llm_wiki)。相关功能在本项目中独立实现，
未复制其代码表达或提示词；固定源码、适配范围与上游 GPL-3.0 许可证说明见同一 notices 文件。

> Han, Feijiang. *PaperForge*. GitHub repository. <https://github.com/FeijiangHan/PaperForge>.

```bibtex
@misc{han_paperforge,
  author       = {Feijiang Han},
  title        = {PaperForge},
  howpublished = {GitHub repository},
  url          = {https://github.com/FeijiangHan/PaperForge}
}
```

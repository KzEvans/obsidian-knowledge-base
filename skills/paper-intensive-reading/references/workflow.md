# Continuous PDF-crop Mode A workflow

## 1. Non-negotiable model

There is one official paper note: `TASK_JSON.note_path`. It was produced by the automatic Forge workflow and is the baseline for comparison. The intensive-reading file at `TASK_JSON.paragraph_reading_note_path` is a process log and verification layer, not a second summary or an independent integration source.

Before explicit merge, keep the primary note body and canonical knowledge pages unchanged. During explicit merge, merge one verified unit only and add only corrections, boundary conditions, missing evidence, or useful detail absent from the baseline.

## 2. Frontmatter contract

Use scalar frontmatter:

```yaml
---
type: paper-intensive-reading-log
status: draft
reading_mode: A
workflow: full-text-continuous-pdf-units
integration_role: auxiliary
primary_source_id: "paper:example"
source_note: "[[wiki/papers/example.md]]"
source_pdf: "[[sources/literature/pdf/example.pdf]]"
extract: "[[extracts/papers/example.md]]"
pdf_extractor: mineru
images_dir: "wiki/papers/images/example"
intensive_images_dir: "wiki/papers/images/example/intensive-reading"
source_display: pdf-crops
allow_image_crops: true
allow_optional_image_crops: false
paragraph_reading_progress: partial
interaction_stage: awaiting_initial_analysis
current_unit: U01
current_unit_score: null
covered_units: 0
total_units: 6
verified_units: ""
merged_units: ""
last_completed_locator: null
generated_at: "ISO timestamp"
updated_at: "ISO timestamp"
---
```

`allow_image_crops: true` records that selecting intensive reading authorizes the required direct-PDF crops. `allow_optional_image_crops` mirrors the legacy `paragraph_reading_figures` checkbox and controls only additional supplemental crops.

Allowed `interaction_stage` values:

- `awaiting_initial_analysis`
- `awaiting_supervisor_answer`
- `awaiting_reconstruction`
- `ready_to_merge`
- `ready_for_next_unit`
- `complete`

`covered_units` counts merged verified units. Keep progress `partial` until all units pass completion checks.

## 3. Document structure

Use exactly one level-one heading:

```markdown
# <display_title>：逐段精读验证日志
```

Maintain these sections:

```markdown
## 使用说明
## 全文推理单元地图
## 交互精读
## Agentic Q&A
## 完成检查
## 知识增长候选
## 人工笔记
<!-- user-notes:start -->
<!-- user-notes:end -->
```

Preserve all user-authored text, existing unit entries, Agentic Q&A, and user-note marker content on every continuation.

## 4. Build the coverage map

Scan the complete main text before presenting U01. Target 4–8 broad units for a normal paper. Use neutral entries without AI semantic labels or locations:

```markdown
- [ ] U01 · 当前：awaiting_initial_analysis
- [ ] U02
- [ ] U03
```

Rules:

- partition the main-text reading order into continuous, mutually exclusive spans;
- merge abstract restatements with their later evidence rather than duplicating them;
- absorb introductions, definitions, transitions, routine methods, and caveats into adjacent substantive spans;
- assign every substantive paragraph, figure, table, equation, and conclusion exactly once;
- include relevant SI only under the unit whose claim points to it;
- do not display AI-inferred unit names, roles, functions, or relationships.

## 5. Direct PDF crop contract

Use MinerU only to navigate text, captions, equations, and page boundaries. Displayed source evidence must come from `source_path` itself.

For every crop, call:

```bash
python3 "<TASK_JSON.paragraph_reading_crop_script>" \
  --pdf "<absolute source PDF>" \
  --page 1 \
  --bbox 120,180,980,1420 \
  --dpi 180 \
  --output "<absolute paragraph_reading_images_dir>/U01/source-p001-01.png" \
  --allowed-root "<absolute paragraph_reading_images_dir>"
```

`--bbox` is `left,top,width,height` in pixels at the selected DPI. Crop text columns in reading order. Use filenames:

- original text: `U01/source-p001-01.png`, `source-p001-02.png`, …;
- relevant visuals: `U01/figure-p002-fig01.png`, `table-p003-table01.png`, or `equation-p003-eq01.png`.

Original-text crops within one unit must form one continuous reading sequence. Collectively, all units must cover the full main text without cherry-picked gaps, excluding only page furniture, references, and non-substantive administrative text. Do not copy MinerU-generated image assets into this directory.

## 6. Unit stage A — source, translation, figure, location, interaction

Use this exact order and heading depth:

```markdown
### U01

#### 原文

![[wiki/papers/images/example/intensive-reading/U01/source-p001-01.png]]
![[wiki/papers/images/example/intensive-reading/U01/source-p001-02.png]]

#### 翻译

<按原文阅读顺序给出连续中文翻译；保留公式、符号和术语边界。>

#### 配图

![[wiki/papers/images/example/intensive-reading/U01/figure-p002-fig01.png]]

#### 原文位置

[[sources/literature/pdf/example.pdf#page=1|PDF p.1]]–[[sources/literature/pdf/example.pdf#page=2|PDF p.2]]

#### 交互

##### 用户初始理解（请填写）

<!-- initial-understanding:U01:start -->
- 我目前的理解：
- 我不确定的是：
<!-- initial-understanding:U01:end -->
```

If no independent visual belongs to the unit, write `本单元无独立配图。` under `#### 配图`. The original crop sequence still exists.

Do not use blockquoted excerpts or OCR text as the displayed original. Do not add a semantic subtitle to `### U01`. Do not add “证据包”, “涵盖内容”, “在全文论证中的作用”, or “与自动笔记的关系”. Put PDF links only under `#### 原文位置`, once per unit.

Set `interaction_stage: awaiting_initial_analysis` and stop. Never write inside the user marker block.

## 7. Explicit initial-understanding submission

Do not infer completion from edited text. While stage is `awaiting_initial_analysis`, only action `submit-initial` may advance. The deterministic runner rejects an empty marker block before invoking the model.

On `submit-initial`, preserve the marker content verbatim and add under `#### 交互`:

```markdown
##### AI 导师诊断

- 已抓住：...
- 需要校正：...
- 尚未解释的推理跳步：...

##### AI 导师关键问题

<one question whose answer most improves understanding>

##### 用户回答（请填写）

<!-- supervisor-answer:U01:start -->
<!-- supervisor-answer:U01:end -->

##### 提示记录
```

Do not add the unit's role or relationship. Do not repeat the PDF location link; all unit-specific discussion refers to the single `原文位置` block. Set stage `awaiting_supervisor_answer` and stop.

When continuing an older log, migrate its map and current unit to the new crop template while preserving every user-written character. Create the required direct-PDF crops before advancing.

## 8. Graded hints

For action `hint`, append exactly one minimal hint under `##### 提示记录` and keep `awaiting_supervisor_answer`:

```markdown
- AI 提示 1（方向）：...
```

Across repeated calls: point to evidence, expose one missing relation, provide a partial scaffold, then give a near-complete route while leaving the conclusion to the user.

## 9. Expert explanation and reconstruction

After the user answers the supervisor question, or on explicit `explain`, add:

```markdown
##### AI 专家解释

- 结论：...
- 推理链：...
- 成立边界：...
- 对自动笔记的核对：无变化 / 需修正 / 有增量
- 不确定性：...

##### 用户重构（请填写）

<!-- reconstruction:U01:start -->
- 作者要解决的问题：
- 推理链（因为…所以…）：
- 最强证据：
- 结论成立的条件：
- 对自动笔记应补充或修正什么：
<!-- reconstruction:U01:end -->
```

Never fill the reconstruction for the user. Keep the single unit location under `原文位置`. Set `awaiting_reconstruction` and stop.

## 10. Scoring and verification

After the user fills reconstruction, score problem identification, reasoning chain, evidence alignment, and boundary/uncertainty from 0–2 each.

If total is below 6 or a major factual error remains, ask one targeted retry question and stay at `awaiting_reconstruction`.

Otherwise add:

```markdown
##### AI 评分

- 问题识别：2/2
- 推理链：1/2
- 证据对应：2/2
- 边界与不确定性：1/2
- 总分：6/8
- 重大事实错误：无
- 反馈：...

<!-- verified-unit:U01:start -->
##### 已验证共同结论（U01）

- 核心结论：...
- 用户成功重构：<faithful compact user-derived rendering>
- 对自动笔记的判定：验证 / 修正 / 增量
- 建议合并增量：<non-duplicative addition or “无”>
- 适用边界与不确定性：...
- 证据定位：见本单元“原文位置”
<!-- verified-unit:U01:end -->
```

Set score, add the ID to `verified_units`, set `ready_to_merge`, and stop. Do not edit the primary note.

## 11. Explicit merge

Merge only when the unit is `ready_to_merge`, scored at least 6, has no major factual error, and its `原文位置` contains an exact primary-PDF page link.

In the primary note maintain:

```markdown
## 精读验证与增量

<!-- intensive-reading:U01:start -->
### U01

- 验证结论：...
- 对原自动笔记的处理：已验证 / 已修正 / 已补充
- 非重复增量：...（没有时明确写“无；原笔记已充分覆盖”）
- 证据与边界：... [[sources/literature/pdf/example.pdf#page=1|PDF p.1]]
- 过程记录：[[wiki/papers/close-reading/example.md#U01|U01 交互精读]]
<!-- intensive-reading:U01:end -->
```

Do not copy the source crops, dialogue, or user answer into the primary note. Update an existing marker in place. After merge, check the unit, add it once to `merged_units`, increment coverage once, and advance to `ready_for_next_unit` or `complete`.

## 12. Completion and knowledge growth

Before completion verify every map item is checked and merged once, coverage counts agree, all substantive text is covered, relevant figures/tables/equations and SI dependencies are accounted for, and no evidence gap remains.

Only after completion generate knowledge-growth candidates. Candidate generation does not modify canonical knowledge. Wait for explicit confirmation and use the existing integration workflow.

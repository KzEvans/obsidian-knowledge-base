# Continuous Mode A workflow

## 1. Non-negotiable model

There is one official paper note: `TASK_JSON.note_path`. It was produced by the automatic Forge workflow and is the baseline for comparison. The intensive-reading file at `TASK_JSON.paragraph_reading_note_path` is a process log and verification layer, not a second summary and not an independent integration source.

Before explicit merge:

- the primary paper note body stays unchanged;
- the log may contain source evidence, user text, dialogue, scoring, and verified joint conclusions;
- canonical knowledge pages stay unchanged.

During explicit merge:

- merge one verified unit only;
- add only corrections, boundary conditions, missing evidence, or useful detail not already represented in the baseline;
- keep the dialogue in the log;
- keep a compact evidence-backed verification/increment entry in the primary note.

## 2. Frontmatter contract

The log uses scalar frontmatter so the deterministic runner can validate it:

```yaml
---
type: paper-intensive-reading-log
status: draft
reading_mode: A
workflow: full-text-reasoning-units
integration_role: auxiliary
primary_source_id: "paper:example"
source_note: "[[wiki/papers/example.md]]"
source_pdf: "[[sources/literature/pdf/example.pdf]]"
extract: "[[extracts/papers/example.md]]"
pdf_extractor: mineru
images_dir: "wiki/papers/images/example"
allow_image_crops: false
paragraph_reading_progress: partial
interaction_stage: awaiting_initial_analysis
current_unit: U01
current_unit_score: null
covered_units: 0
total_units: 12
verified_units: ""
merged_units: ""
last_completed_locator: null
generated_at: "ISO timestamp"
updated_at: "ISO timestamp"
---
```

Allowed `interaction_stage` values:

- `awaiting_initial_analysis`
- `awaiting_supervisor_answer`
- `awaiting_reconstruction`
- `ready_to_merge`
- `ready_for_next_unit`
- `complete`

`covered_units` counts merged verified units. `paragraph_reading_progress` stays `partial` until `covered_units == total_units` and all coverage checks pass. `verified_units` and `merged_units` are comma-separated stable unit IDs.

## 3. Document structure

Use exactly one level-one heading:

```markdown
# <display_title>：逐段精读验证日志
```

Then maintain these sections:

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

Preserve all existing unit entries, Agentic Q&A, and user-note marker content on every continuation.

## 4. Build the coverage map

Before presenting U01, inspect the complete extraction and primary note. Build ordered, mutually exclusive units that cover the full paper:

```markdown
- [ ] U01 · 问题与缺口 · PDF p.1–2 · 当前：awaiting_initial_analysis
- [ ] U02 · 关键机制与设计 · PDF p.2–4
- [ ] U03 · 主要证据链 · PDF p.4–7
```

Rules:

- use the paper's argument, not heading boundaries alone;
- merge abstract claims with their later evidence units instead of duplicating them;
- attach introductions, definitions, transitions, routine methods, and caveats to the closest core move;
- assign each substantive paragraph, equation, figure, table, and conclusion to exactly one unit;
- list page ranges and included figure/table/equation IDs;
- note relevant SI dependencies under the owning unit;
- do not omit material merely because it looks non-core.

## 5. Unit stage A — evidence and initial understanding

Create the current unit entry:

```markdown
### U01 · <reasoning move> · PDF p.1–2

#### 证据包

> <only the source excerpts necessary to reconstruct this unit>

- 原文定位：[[sources/literature/pdf/example.pdf#page=1|PDF p.1]]
- 涵盖内容：§1 ¶1–5；Fig. 1；Eq. (1)
- 在全文论证中的作用：问题界定 / 方法选择 / 证据 / 边界
- 与自动笔记的关系：已覆盖 / 疑似缺失 / 疑似冲突 / 待验证

#### 用户初始理解（请填写）

- 这部分在说什么：
- 作者为什么在这里做这一步：
- 我认为最关键的证据或推理是：
- 我不确定的是：
```

Do not write inside the user template. Set `interaction_stage: awaiting_initial_analysis` and stop.

## 6. Unit stage B — supervisor diagnosis

Proceed only when the user has written meaningful text in the initial-understanding fields. Preserve it verbatim. Add:

```markdown
#### AI 导师诊断

- 已抓住：...
- 需要校正：...
- 尚未解释的推理跳步：...
- 与原文证据的对应：... [[...pdf#page=N|PDF p.N]]

#### AI 导师关键问题

<one question whose answer most improves understanding>

#### 用户回答（请填写）


#### 提示记录

```

Ask exactly one key question. Set `interaction_stage: awaiting_supervisor_answer` and stop.

## 7. Unit stage C — graded hints

When action is `hint`, add exactly one minimal hint under `#### 提示记录`:

```markdown
- AI 提示 1（方向）：...
```

Escalation order across repeated hint calls:

1. point to the relevant evidence or variable;
2. expose one missing relation;
3. provide a partial reasoning scaffold;
4. give a near-complete route but leave the conclusion to the user.

Do not reveal the full answer in the first hint. Keep `interaction_stage: awaiting_supervisor_answer` and stop.

## 8. Unit stage D — expert explanation and reconstruction

After the user answers the supervisor question, or when action is explicitly `explain`, add:

```markdown
#### AI 专家解释

- 结论：...
- 证据：... [[...pdf#page=N|PDF p.N]]
- 推理链：...
- 成立边界：...
- 与自动笔记的差异：无 / 缺失 / 过度概括 / 事实冲突
- 不确定性：...

#### 用户重构（请填写）

- 作者要解决的问题：
- 推理链（因为…所以…）：
- 最强证据：
- 结论成立的条件：
- 对自动笔记应补充或修正什么：
```

Never write the reconstruction for the user. Set `interaction_stage: awaiting_reconstruction` and stop.

## 9. Unit stage E — scoring and verification

After the user fills the reconstruction, score:

- problem identification: 0–2;
- reasoning chain: 0–2;
- evidence alignment: 0–2;
- boundary/uncertainty: 0–2.

Add:

```markdown
#### AI 评分

- 问题识别：2/2
- 推理链：1/2
- 证据对应：2/2
- 边界与不确定性：1/2
- 总分：6/8
- 重大事实错误：无
- 反馈：...
```

If score is below 6 or a major factual error remains, ask one targeted retry question, clear only the empty retry field, keep prior user text, and stay at `awaiting_reconstruction`.

If score is at least 6 and there is no major factual error, create:

```markdown
<!-- verified-unit:U01:start -->
#### 已验证共同结论（U01）

- 核心结论：...
- 原文证据：... [[...pdf#page=N|PDF p.N]]
- 用户成功重构：<quote or faithful compact rendering; label it as user-derived>
- 对自动笔记的判定：验证 / 修正 / 增量
- 建议合并增量：<only the non-duplicative addition; say “无” when already covered>
- 适用边界与不确定性：...
<!-- verified-unit:U01:end -->
```

Set the unit score, add the ID to `verified_units`, set `interaction_stage: ready_to_merge`, and stop. Do not edit the primary note.

## 10. Explicit merge

Merge is valid only when:

- `interaction_stage` is `ready_to_merge`;
- `current_unit_score >= 6`;
- the current verified-unit marker exists and contains an exact PDF page link;
- no unresolved major factual error or page ambiguity is present.

In the primary note, maintain one compact section:

```markdown
## 精读验证与增量

<!-- intensive-reading:U01:start -->
### U01 · <reasoning move>

- 验证结论：...
- 对原自动笔记的处理：已验证 / 已修正 / 已补充
- 非重复增量：...（没有增量时明确写“无；原笔记已充分覆盖”）
- 证据与边界：... [[sources/literature/pdf/example.pdf#page=N|PDF p.N]]
- 过程记录：[[wiki/papers/close-reading/example.md#U01|U01 交互精读]]
<!-- intensive-reading:U01:end -->
```

Do not copy the full dialogue or all source excerpts into the primary note. If the marker already exists, update it in place; never append a duplicate. Preserve all unrelated primary-note content and human-review sections.

After a successful merge:

- add current ID to `merged_units`;
- increment `covered_units` exactly once;
- check the unit in the coverage map;
- set `last_completed_locator` to its exact PDF range;
- if units remain, set `interaction_stage: ready_for_next_unit`;
- if all units are merged and the completion check passes, set `interaction_stage: complete` and `paragraph_reading_progress: complete`.

The next `continue` after `ready_for_next_unit` presents the next unmerged unit at stage A and stops.

## 11. Completion check

Before declaring complete, verify:

- every map item is checked and appears once in `merged_units`;
- `covered_units == total_units`;
- all substantive text is mapped;
- every relevant figure, table, and equation has been interpreted or explicitly marked not evidential;
- relevant SI dependencies have been checked and separately cited;
- no page ambiguity or major factual error remains;
- the paper-level chain can be reconstructed as problem → design → evidence → conclusion → boundary.

Write the result under `## 完成检查`. Time limits never satisfy this check.

## 12. Knowledge-growth candidates

Only after completion, generate candidates under `## 知识增长候选`:

```markdown
### 候选 K01

- 类型：概念 / 机制 / 方法 / 材料 / 矛盾 / 假设 / 实验启发
- 候选表述：...
- 来源单元：U03
- PDF 证据：[[...pdf#page=N|PDF p.N]]
- 与现有知识的关系：新增 / 强化 / 条件化 / 冲突
- 状态：待人工确认
```

Generating a candidate is not authorization to edit canonical knowledge pages. Only the user's explicit confirmation plus the existing integration workflow may do that.

# Verified intensive-reading unit merge

Merge exactly one verified unit from `paragraph_reading_note_path` into the sole
official paper note at `note_path`. Use the `paper-intensive-reading` skill's
`merge` operation.

## Preconditions

- The log is auxiliary and its `interaction_stage` is `ready_to_merge`.
- The current unit has a score of at least 6/8 and no major factual error.
- Its stable verified-unit block has exact primary-PDF page evidence.
- The current unit is not already present in `merged_units`.

If any precondition fails, change neither file and return `blocked`.

## Allowed writes

Write only `note_path` and `paragraph_reading_note_path`. Do not modify source
PDFs, MinerU extracts or assets, the queue, `wiki/index.md`, or canonical topic,
method, material, mechanism, question, project, or synthesis pages. The runner
owns lifecycle and coverage frontmatter.

## Merge semantics

Maintain one `## 精读验证与增量` section in the primary note. Within it, write or
update exactly one stable block:

```markdown
<!-- intensive-reading:U01:start -->
### U01 · <reasoning move>

- 验证结论：...
- 对原自动笔记的处理：已验证 / 已修正 / 已补充
- 非重复增量：...（无增量时明确写“无；原笔记已充分覆盖”）
- 证据与边界：... [[sources/literature/pdf/example.pdf#page=2|PDF p.2]]
- 过程记录：[[wiki/papers/close-reading/example.md#U01|U01 交互精读]]
<!-- intensive-reading:U01:end -->
```

Do not copy source excerpts, tutoring dialogue, hints, or the user's full answer
into the primary note. Preserve all unrelated baseline content and all human review
sections. If the marker exists, update in place rather than duplicating it.

After writing the primary block, update the log: check the unit in the full-text
map, add it once to `merged_units`, increment `covered_units` once, and set the
last locator. Use `ready_for_next_unit` if units remain. Use `complete` and
`paragraph_reading_progress: complete` only when every mapped unit and relevant
figure/table/equation/SI dependency passes the completion check.

Do not generate or integrate canonical knowledge candidates during this merge.
Finish with result JSON using `operation: paragraph-merge`, `status: drafted`, and
only the two files actually updated.

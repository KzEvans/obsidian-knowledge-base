# Human-selected intensive reading workflow

The human has checked `paragraph_reading` in the primary paper note. Use the installed `paper-intensive-reading` skill and its complete reference workflow.

## Fixed choices

- Mode: continuous full-text Mode A, normally divided into 4–8 non-overlapping units.
- Language: Chinese.
- Baseline: the automatic paper note at `note_path`.
- Authority: the primary PDF at `source_path`.
- Displayed source: searchable paragraphs from the cached extraction, checked against the PDF when ambiguous; never source-text screenshots, blockquotes, or copied MinerU images.
- Action: exactly `TASK_JSON.intensive_reading_action`.
- One call advances at most one interaction stage.

Do not ask for a reading contract, section range, or summary format. Do not create another final paper summary.

## Required unit layout

Use a neutral heading such as `### U01`, then exactly:

1. `#### 原文与翻译`: sequential `P01`, `P02`, … blocks, each containing `###### 原文` with one extracted paragraph followed immediately by `###### 翻译` for that paragraph;
2. an optional relevant figure/table/equation crop immediately after the matching paragraph's translation;
3. `#### 原文位置`: exact primary-PDF page link(s), stated once after all paragraph pairs;
4. `#### 交互`: the human/AI interaction state.

Do not collect a large source block followed by a large translation block. Do not create separate `#### 原文`, `#### 翻译`, or `#### 配图` sections. Do not display an AI-authored unit title, purpose, role, covered-content list, or relationship to the automatic note. Do not repeat PDF page links elsewhere inside the unit.

## Extracted text and direct PDF visual crops

Use `extract_path` for the searchable source paragraphs, reading order, equations, captions, and page boundaries. Prefer MinerU and honor the recorded `pdftotext` fallback when applicable. Preserve source wording and paragraph boundaries wherever possible; correct only obvious extraction defects verified against `source_pdf_absolute`.

Use `source_pdf_absolute` as the visual authority. For every relevant figure, table, or equation, call `paragraph_reading_crop_script`, write the PNG under `paragraph_reading_images_absolute/<unit>/`, and embed it immediately after the matching translation. Do not crop ordinary source text or copy MinerU-generated images.

All mapped units together must cover the full main text in reading order, excluding only page furniture, references, and non-substantive administrative text. `paragraph_reading_figures` controls only extra supplemental crops retained for backward compatibility. Directly relevant visual crops are authorized by the human's selection of intensive reading.

Use supporting information only when the primary paper points to it for evidence needed by the current unit. Cite SI separately.

## Write boundary

For `continue`, `submit-initial`, `hint`, or `explain`:

- read `note_path`, `extract_path`, `source_path`, and relevant listed SI;
- write only `paragraph_reading_note_path` and files inside `paragraph_reading_images_dir`;
- never modify the primary note body, source files, extraction cache, queue, index, or canonical knowledge pages.

Preserve user-authored text verbatim. The log remains `integration_role: auxiliary` and cannot be integrated independently.

## State transition

- no log or `ready_for_next_unit` + `continue` → show the next unit in the required layout and an empty marked initial-understanding block; set `awaiting_initial_analysis`; stop;
- `awaiting_initial_analysis` → do not advance on `continue`; wait for explicit `submit-initial`;
- `submit-initial` → preserve submitted text, write diagnosis and one supervisor question, set `awaiting_supervisor_answer`; stop;
- `hint` → add one graded hint and stay `awaiting_supervisor_answer`; stop;
- answered question or `explain` → write expert explanation and an empty marked reconstruction block, set `awaiting_reconstruction`; stop;
- filled reconstruction + `continue` → score 0–8; request one retry or create the stable verified-unit block and set `ready_to_merge`; stop;
- `ready_to_merge` → do not edit the primary note; wait for the separate merge command.

When continuing a legacy log, migrate its map and current unit to the interleaved paragraph-pair layout while preserving all user text exactly. Replace source-text crops with extracted text, retain or recrop only relevant visuals, and do not advance the interaction stage. Never fill a user field.

Finish with result JSON using `operation: paragraph-reading`, `status: drafted`, and only files actually updated.

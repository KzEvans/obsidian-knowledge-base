# Human-selected intensive reading workflow

The human has checked `paragraph_reading` in the primary paper note. Use the installed `paper-intensive-reading` skill and its complete reference workflow.

## Fixed choices

- Mode: continuous full-text Mode A, normally divided into 4–8 non-overlapping units.
- Language: Chinese.
- Baseline: the automatic paper note at `note_path`.
- Authority: the primary PDF at `source_path`.
- Displayed source: direct PDF crops, never copied MinerU assets or blockquoted OCR text.
- Action: exactly `TASK_JSON.intensive_reading_action`.
- One call advances at most one interaction stage.

Do not ask for a reading contract, section range, or summary format. Do not create another final paper summary.

## Required unit layout

Use a neutral heading such as `### U01`, then exactly:

1. `#### 原文`: ordered crops that form one continuous passage;
2. `#### 翻译`: continuous corresponding Chinese translation;
3. `#### 配图`: relevant figure/table/equation crops or `本单元无独立配图。`;
4. `#### 原文位置`: exact primary-PDF page link(s), stated once;
5. `#### 交互`: the human/AI interaction state.

Do not display an AI-authored unit title, purpose, role, covered-content list, or relationship to the automatic note. Do not repeat PDF page links elsewhere inside the unit.

## MinerU navigation and direct PDF crops

Use `extract_path` to navigate extracted text, equations, captions, and page boundaries. Use `source_pdf_absolute` as the visual authority. For every displayed original-text or visual crop, call `paragraph_reading_crop_script` and write the PNG under `paragraph_reading_images_absolute/<unit>/`.

Crop multi-column text in reading order. The ordered original crops within each unit must be continuous; all mapped units together cover the full main text, excluding only page furniture, references, and non-substantive administrative text.

`paragraph_reading_figures` controls only extra supplemental crops retained for backward compatibility. Required original and directly relevant visual crops are authorized by the human's selection of intensive reading.

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

When continuing a legacy log, migrate its map and current unit to the direct-PDF-crop layout while preserving all user text exactly. Never fill a user field.

Finish with result JSON using `operation: paragraph-reading`, `status: drafted`, and only files actually updated.

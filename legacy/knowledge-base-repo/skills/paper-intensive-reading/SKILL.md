---
name: paper-intensive-reading
description: Interactively deep-read one academic paper in Chinese as a continuous full-text sequence of a few non-overlapping units, interleaving each extracted source paragraph with its translation and placing relevant direct-PDF visual crops immediately after the matching paragraph pair. Requires explicit submission of user understanding and keeps results as a separate verification/increment layer until merge. Use when the user starts, continues, submits, hints, explains, reconstructs, scores, shows progress, or merges an opt-in intensive/paragraph reading; when TASK_JSON contains paragraph_reading_note_path; or when an Obsidian paper is marked paragraph_reading. Do not use for automatic paper-note generation, bulk summaries, or unreviewed canonical knowledge integration.
---

# Paper Intensive Reading

## Purpose

Run interactive Mode A reading without creating a competing paper summary. Treat the automatic Forge paper note as a fallible baseline and the primary PDF as authority. Keep the intensive-reading log auxiliary. Modify the primary note only during explicit merge, adding only verified corrections or genuinely new evidence-backed detail.

This workflow adapts Mode A from `paper-reading`, but replaces scattered excerpts with continuous full-text units whose extracted source paragraphs and translations alternate in reading order. Keep relevant visuals as direct PDF crops. Retain explicit user submission, reconstruction, scoring, and gated merge semantics.

Write the durable log with workflow identifier `full-text-unlabeled-paragraph-pairs`.

## Required resources

Read [references/workflow.md](references/workflow.md) completely before acting. It defines the state machine, exact unit template, crop rules, write boundaries, and merge contract.

Use [scripts/crop_pdf_region.py](scripts/crop_pdf_region.py) for every figure, table, or equation image shown in a unit. The script renders the selected region directly from the primary PDF; never embed MinerU-generated images as displayed visuals.

## Select the operation

Infer the operation from the request and `TASK_JSON.intensive_reading_action`:

- `continue`: initialize the unit map, advance after a supervisor answer or reconstruction, or open the next unit.
- `submit-initial`: accept the current user-written initial understanding and advance to supervisor diagnosis.
- `hint`: add one graded hint for the current supervisor question.
- `explain`: add the expert explanation and open reconstruction.
- `progress`: report coverage and current state without editing files.
- `argument-chain`: show the reconstructed paper-level chain without editing files.
- `merge`: merge exactly one `ready_to_merge` verified unit into the primary note.
- `complete`: verify full coverage; never infer completion from time or token limits.
- `generate-candidates`: generate knowledge-growth candidates only after full reading.
- `confirm-integrate`: integrate only candidates explicitly confirmed by the user through the repository workflow.

If no operation is supplied, use `continue`. Never ask for an up-front reading contract, section range, or output mode when the pipeline supplies a paper task.

## Evidence hierarchy

Use this order:

1. original primary PDF with exact page evidence;
2. visually checked figures, tables, equations, and relevant SI;
3. verified joint conclusions in the intensive-reading log;
4. existing automatic paper note as a fallible baseline;
5. clearly labeled background knowledge or inference.

Never treat the automatic note as primary evidence. Preserve conflicts and prefer the PDF.

## Full-text unit map

Scan the complete main text and divide it into a small ordered set of non-overlapping continuous units. Target 4–8 units for a normal paper; use fewer or more only when the document structure requires it. Units collectively cover the whole main-text reading sequence. Merge background, definitions, transitions, and minor procedures into adjacent substantive units instead of creating tiny fragments.

Use neutral IDs only (`U01`, `U02`, …) in the displayed map and headings. Do not write AI-inferred unit titles, roles, functions, or relationships. Assign every substantive claim, method choice, result, limitation, figure, table, and equation to exactly one unit.

## Unit display contract

For each unit, show exactly this content order:

1. `原文与翻译`: sequential `P01`, `P02`, … blocks. Each block displays one searchable extracted source paragraph followed immediately by its Chinese translation, without visible `原文` or `翻译` labels. Use only the invisible `<!-- pair:Pxx:split -->` boundary between them. If that paragraph has a relevant figure, table, or equation, place its direct-PDF crop immediately after the translation in the same `Pxx` block;
2. `原文位置`: the unit's PDF location, stated once after all paragraph pairs;
3. `交互`: user understanding, AI diagnosis/question, hints, explanation, reconstruction, scoring, and verified conclusion as the state advances.

Preserve paragraph order and boundaries wherever the extraction permits. Never collect all source paragraphs before all translations. Do not add visible source/translation labels, use blockquotes, crop ordinary text into images, create a separate `配图` section, repeat PDF location links elsewhere inside the same unit, or add fields such as “在全文论证中的作用” or “与自动笔记的关系”.

## Explicit submission and stage discipline

Advance only one stage per invocation and stop. Never infer that initial understanding is finished merely because fields contain text. At `awaiting_initial_analysis`, wait for action `submit-initial`. Preserve all user-authored text verbatim. Reject an empty submission.

Normal cycle:

1. show interleaved source/translation paragraph pairs, paragraph-local visual crops when relevant, one location, and an empty initial-understanding block; stop;
2. after explicit `submit-initial`, diagnose and ask one supervisor question; stop;
3. give one graded hint only when requested;
4. after an answer or explicit `explain`, teach the unit and open an empty reconstruction block; stop;
5. after reconstruction, score 0–8 and request one targeted retry or create a verified joint conclusion;
6. set `ready_to_merge`; do not edit the primary note;
7. only `merge` may add a verified increment to the primary note.

A score of at least 6/8 is necessary but not sufficient; any major factual error blocks verification.

## Extracted text and PDF visual crops

Use `TASK_JSON.extract_path` as the cached source-text, structure, equation, caption, page-navigation, and translation layer when it matches the source hash. Prefer MinerU output; if extraction falls back to `pdftotext`, use its text and record that limitation. Do not rerun MinerU when the cached extraction is valid.

Use `TASK_JSON.source_path` as the authority for checking extracted text and for every displayed visual. Correct only obvious extraction artifacts that can be verified against the PDF; do not silently paraphrase the source paragraph. Crop only relevant figures, tables, or equations with `TASK_JSON.paragraph_reading_crop_script` into `TASK_JSON.paragraph_reading_images_dir/<unit>/`, then embed each crop after the paragraph pair that invokes or explains it.

`paragraph_reading_figures` is retained only as a backward-compatible opt-in for extra supplemental crops. Directly relevant figure/table/equation crops are always permitted in the dedicated intensive-reading directory. Ordinary source text remains searchable Markdown and is never stored as a crop.

## Write boundary

For `continue`, `submit-initial`, `hint`, and `explain`, write only:

- exact `TASK_JSON.paragraph_reading_note_path`;
- required relevant-visual PDF crops under exact `TASK_JSON.paragraph_reading_images_dir`.

Do not modify the automatic note body, PDF, extraction cache, queue, index, or canonical knowledge pages. The deterministic runner alone updates managed status properties.

For `merge`, write only the exact primary note and intensive-reading log. Do not update canonical knowledge pages.

## Completion and knowledge growth

Full reading is complete only when every mapped unit is verified and merged, all relevant visual/equation evidence is accounted for, and no unresolved evidence gap remains. Only then generate knowledge-growth candidates. Candidate generation never authorizes canonical writes; wait for explicit confirmation and use the existing integration workflow.

Finish pipeline-backed work with JSON matching `system/knowledge/result.schema.json` and list only files actually updated.

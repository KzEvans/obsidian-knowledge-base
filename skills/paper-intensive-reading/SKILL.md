---
name: paper-intensive-reading
description: Interactively deep-read one academic paper in Chinese as a continuous, full-text sequence of non-overlapping reasoning units, using the existing automatic paper note as a baseline and producing only a separate verification log until the user explicitly merges a verified unit. Use when the user asks to start, continue, hint, explain, reconstruct, score, show progress, or merge an opt-in intensive/paragraph reading; when TASK_JSON contains paragraph_reading_note_path; or when an Obsidian paper is marked paragraph_reading. Do not use for automatic paper-note generation, bulk summaries, or unreviewed canonical knowledge integration.
---

# Paper Intensive Reading

## Purpose

Guide an interactive Mode A reading without creating a competing paper summary. Treat the existing automatic paper note as the baseline and the primary PDF as the authority. Keep the intensive-reading log auxiliary. Modify the primary note only during an explicit merge action, and then add only verified corrections or genuinely new evidence-backed detail.

This workflow is adapted from the interactive Mode A of `paper-reading`, but replaces paragraph-isolated accumulation and the up-front reading contract with continuous full-paper coverage, reasoning-unit consolidation, user reconstruction, scoring, and gated merge semantics.

## Required reference

Read [references/workflow.md](references/workflow.md) completely before acting. It defines the state machine, templates, evidence hierarchy, MinerU routing, write boundaries, and merge contract.

## Select the operation

Infer the operation from the user request and `TASK_JSON.intensive_reading_action`:

- `continue`: initialize the map or advance exactly one interaction stage.
- `hint`: give one graded hint for the current supervisor question; keep the stage open.
- `explain`: provide the expert explanation and open the reconstruction stage.
- `progress`: report coverage and current state without editing files.
- `argument-chain`: show the reconstructed paper-level argument chain without editing files.
- `merge`: merge exactly one `ready_to_merge` verified unit into the primary note.
- `complete`: verify full coverage; do not claim completion from elapsed time or token limits.
- `generate-candidates`: after full reading, generate knowledge-growth candidates only.
- `confirm-integrate`: integrate only candidates explicitly confirmed by the user and only through the repository's canonical integration workflow.

If no operation is supplied, use `continue`. Never ask for an up-front reading contract, section range, or output mode when the pipeline already supplies a paper task.

## Source hierarchy

Use this priority order:

1. original primary PDF with exact page evidence;
2. visually checked relevant figures, tables, equations, and SI;
3. verified joint conclusions in the intensive-reading log;
4. existing automatic paper note as a fallible baseline;
5. clearly labeled background knowledge or inference.

Never silently treat the baseline note as evidence. When it conflicts with the PDF, preserve the conflict and prefer the PDF.

## Full-text unit map

On initialization, scan the complete paper and create an ordered map of non-overlapping reasoning units covering the entire main text. A unit is a coherent move in the author's argument, not necessarily one paragraph. Merge background, definitions, setup, transitions, and minor procedural prose into the nearest core unit. Preserve every substantive claim, method choice, result, limitation, figure, table, and equation in exactly one unit.

Include relevant SI only when the paper points to it for a claim being checked. Do not independently summarize every SI page.

## Interaction discipline

Advance only one stage per invocation and then stop. Never fill a user field on the user's behalf. Preserve all user-authored text verbatim. Label every model addition as AI diagnosis, hint, explanation, score, or joint conclusion.

The normal cycle is:

1. show evidence and an empty initial-understanding template; stop;
2. after the user fills it, diagnose and ask one key supervisor question; stop;
3. give graded hints only when requested;
4. after an answer or explicit `explain`, teach the unit and open an empty reconstruction template; stop;
5. after reconstruction, score 0–8 and either request one targeted retry or create a verified joint conclusion;
6. set `ready_to_merge`; never edit the primary note in this operation;
7. only `merge` may add the verified increment to the primary note.

A score of at least 6/8 is necessary but not sufficient: any major factual error blocks verification.

## MinerU evidence layer

When `TASK_JSON.extract_path` exists, use it as the primary navigation layer. It is normally a cached MinerU Markdown extraction with `## Page N` boundaries, MathJax equations, tables, captions, and links to extracted visual assets. Do not rerun MinerU when the cached extraction matches the source hash and configured extractor signature.

Use the original PDF for visual or layout checks whenever extraction is ambiguous, especially for multi-panel figures, table headers, subscripts, superscripts, equation layout, and page boundaries. If MinerU falls back to `pdftotext`, state the limitation in the log. Never invent a page number.

`paragraph_reading_figures` authorizes copying selected crops into the paper's `images_dir`; it does not authorize ignoring scientific figures when false. Figures and tables remain part of full-text coverage through the extraction/PDF evidence, but no extra crop is persisted without permission.

## Write boundary

For `continue`, `hint`, and `explain`, write only:

- exact `TASK_JSON.paragraph_reading_note_path`;
- selected image files under exact `TASK_JSON.images_dir` when crop persistence is authorized.

Do not modify the automatic paper note, PDF, extraction cache, queue, index, or canonical knowledge pages. The deterministic runner alone may update managed status properties.

For `merge`, write only:

- exact `TASK_JSON.note_path`;
- exact `TASK_JSON.paragraph_reading_note_path`.

Do not create a second final paper note. Do not update canonical topic, method, material, or mechanism pages during merge.

## Evidence and uncertainty

Attach an exact primary-PDF page link to every paper-derived claim. Cite SI separately when used. Distinguish paper facts, user interpretation, AI explanation, inference, and unresolved uncertainty. If the page cannot be established, mark `（页码待核对）` and keep the unit unverified.

For an external factual question, use Agentic Q&A: research only the question actually asked, cite sources, separate outside evidence from the paper, and do not let external material silently rewrite the paper's claim.

## Completion and knowledge growth

Full reading is complete only when every mapped unit is verified and merged, all relevant figures/tables/equations are accounted for, and no unresolved evidence gap remains. Then set the log to complete and update the main note's managed coverage properties through the runner.

Only after full reading may you generate candidate knowledge growth. Candidate generation does not modify canonical knowledge. Wait for explicit user confirmation before the existing integration workflow writes canonical pages.

Finish pipeline-backed work with JSON matching `system/knowledge/result.schema.json` and list only files actually updated.

# Human-selected intensive reading workflow

The caller supplies one paper `TASK_JSON`. The human has already checked
`paragraph_reading` in the primary paper note. Use the installed
`paper-intensive-reading` skill and its complete reference workflow.

## Fixed choices

- Mode: continuous full-text Mode A organized as non-overlapping reasoning units.
- Language: Chinese.
- Baseline: the existing automatic paper note at `note_path`.
- Authority: the primary PDF and exact page evidence.
- Action: exactly `TASK_JSON.intensive_reading_action`.
- One call advances at most one interaction stage and then stops.

Do not ask for a reading contract, section range, or summary format. Do not create
another final paper summary.

## MinerU and visual evidence

Use `extract_path` first. The runner has already created or validated this cached,
page-delimited Markdown extraction. When `pdf_extractor_used` is `mineru`, it
contains MinerU equations, tables, captions, and extraction-asset links. Inspect
`source_path` whenever layout, a multi-panel figure, a formula, a table header, or
a page boundary remains ambiguous.

Figures, tables, and equations that contribute to the paper's reasoning must be
covered regardless of `paragraph_reading_figures`. That checkbox only grants
permission to copy selected, visually checked image assets into the existing
paper-specific `images_dir`. When false, do not create or embed image files.

Use `supporting_information` only when the primary paper points to SI for evidence
needed by the current unit. Cite the SI file and page independently.

## Write boundary

For `continue`, `hint`, or `explain`:

- read `note_path`, `extract_path`, `source_path`, and relevant listed SI;
- write only `paragraph_reading_note_path` and permitted files inside `images_dir`;
- never modify the primary note body, source files, extraction cache, queue, index,
  or canonical knowledge pages.

Preserve all user-authored text verbatim. Clearly label AI diagnosis, hints,
explanations, scores, and verified conclusions. The log remains
`integration_role: auxiliary` and can never be integrated independently.

## State transition

Follow the skill's frontmatter and stable-marker contract exactly. Initialize the
full reasoning-unit map before presenting U01. Then perform only the transition
allowed by the current state:

- no log or `ready_for_next_unit` → show the next evidence package and empty user
  initial-understanding fields; set `awaiting_initial_analysis`; stop;
- filled initial understanding → write AI diagnosis and one supervisor question;
  set `awaiting_supervisor_answer`; stop;
- `hint` → add one graded hint and keep `awaiting_supervisor_answer`; stop;
- answered question or `explain` → write the expert explanation and empty user
  reconstruction fields; set `awaiting_reconstruction`; stop;
- filled reconstruction → score 0–8; either request one targeted retry or create
  the stable verified-unit block and set `ready_to_merge`; stop;
- `ready_to_merge` → do not advance or edit the primary note; tell the user to run
  the separate merge command.

Never fill a user field. A score below 6/8, a major factual error, or an uncertain
page blocks `ready_to_merge`.

Finish with result JSON using `operation: paragraph-reading`, `status: drafted`,
and only files actually updated.

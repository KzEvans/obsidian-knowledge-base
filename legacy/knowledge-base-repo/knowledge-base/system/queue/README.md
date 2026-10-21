# Knowledge queue

`pending.json` is owned by `system/knowledge/run_pipeline.py`. Do not edit it manually.

Task lifecycle:

`pending → drafted → reviewed → integrated`

Exceptional states are `failed`, `needs_ocr`, and `superseded`.

Sources discovered by `sync_zotero_doc.py --organize-only` use `awaiting_generation`.
Ordinary scans preserve that state. Explicitly release one with
`run_pipeline.py queue-held --id <task-id>`; this queues it for the normal worker.

Paper tasks may also carry a separate `paragraph_reading_status` without changing
their main lifecycle. Its states are `running`, `partial`, `completed`, and `failed`.
The workflow is never selected automatically: a human first checks
`paragraph_reading` in the primary paper note, then starts or continues Mode A from
Obsidian or with `run_pipeline.py paragraph-read --note ...`.

Use `run_pipeline.py redraft --note <exact-primary-note>` to regenerate an existing
paper through the current Forge workflow. This is the supported way to move a
completed paper task back to `pending`; do not edit `pending.json` directly.
`run_pipeline.py cancel-redrafts` safely stops the queued batch by restoring each
unfinished redraft's previous lifecycle state after its running process has ended.

Set `ingest_priority_collections` in the local knowledge config to collection paths (in priority order). Pending tasks in those paths and their descendants run first; explicit `ingest-next --note` still selects that exact note. Failed tasks still require an explicit retry.

`ingest_paused: true` temporarily pauses automatic selection during maintenance; `ingest-next --note` can still run an explicitly selected note. `forge_model` optionally pins paper generation to a CLI model without changing global settings. Phase A uses at most 60% of the shared generation time, capped by `forge_plan_timeout_seconds` (900 seconds by default); the total job deadline remains unchanged.

After explicit user authorization, `forge_job_timeout_seconds` can override the default shared 30-minute paper deadline. The Obsidian ingest wrapper reads the same setting and adds 5 minutes; idle protection remains separate. Leave the field null to preserve the existing deadline settings.

# Automated knowledge pipeline

The pipeline watches the Zotero manifest and human experiment notes, tracks content hashes, extracts structured PDF content, creates Codex drafts, integrates reviewed notes, and produces weekly health reports.

Common commands:

```bash
/usr/bin/python3 system/knowledge/run_pipeline.py scan
/usr/bin/python3 system/knowledge/run_pipeline.py status
/usr/bin/python3 system/knowledge/run_pipeline.py ingest-next
/usr/bin/python3 system/knowledge/run_pipeline.py paragraph-read --note "wiki/papers/YYYY-MM-DD - First Author - Paper Title.md"
/usr/bin/python3 system/knowledge/run_pipeline.py paragraph-read --note "wiki/papers/YYYY-MM-DD - First Author - Paper Title.md" --action hint
/usr/bin/python3 system/knowledge/run_pipeline.py paragraph-merge --note "wiki/papers/YYYY-MM-DD - First Author - Paper Title.md"
/usr/bin/python3 system/knowledge/run_pipeline.py redraft --note "wiki/papers/YYYY-MM-DD - First Author - Paper Title.md"
/usr/bin/python3 system/knowledge/run_pipeline.py integrate --note "wiki/papers/YYYY-MM-DD - First Author - Paper Title.md"
/usr/bin/python3 system/knowledge/run_pipeline.py lint
```

Obsidian exposes equivalent commands. Automatic ingest processes one source at a time.
`redraft` only requeues the exact existing primary paper note supplied with `--note`;
the next `ingest-next` regenerates it with the current Forge workflow and returns it
to draft review without editing queue JSON by hand. Both normal paper ingest and
redrafts have a 30-minute single-paper limit (`codex_timeout_seconds` and
`redraft_timeout_seconds`, both defaulting to 1800 seconds).

Paper extraction uses MinerU by default. Its structured content list is regrouped by
`page_idx`, preserving formulas, tables, figures, captions, and `## Page N` evidence
boundaries in `extracts/papers/*.md`. MinerU's complete extraction cache is kept in
`extracts/papers/assets/<attachment-key>/<source-hash>/`. Images actually selected for
a note are copied to `wiki/papers/images/<exact-note-stem>/`; each note records that
directory in its `images_dir` property and may only embed assets from its own directory.
`pdftotext -layout` remains
an automatic fallback if MinerU is unavailable, times out, fails, or produces too little
content. A task is marked `needs_ocr` only when the fallback also produces insufficient
text.

The important parser settings in `config.json` are:

- `pdf_extractor`: normally `mineru`.
- `mineru_path`: absolute path to the isolated MinerU executable.
- `mineru_backend`: `pipeline` is the conservative local default.
- `mineru_method`: `auto` chooses embedded text or OCR.
- `mineru_model_cache`: local model cache outside the iCloud vault.
- `mineru_fallback_to_pdftotext`: keep `true` for unattended operation.

If Zotero sync has cached supporting-information PDFs, their paths and availability
are attached to the paper task. They are not extracted by default. Forge Paper Note opens SI
only for a specific claim that the primary paper explicitly delegates to SI, and cites
the exact SI page when used.

Paper draft filenames, level-one headings, and index aliases follow
`YYYY-MM-DD - 第一作者 - 文献标题`. The date is fixed when draft generation first starts.
Paper frontmatter always includes `impact_factor`, `impact_factor_year`, and
`impact_factor_source`. Zotero sync uses a cached Codex live-web lookup against
official publisher or Clarivate pages and records `impact_factor_retrieved_at`;
unavailable values remain explicit YAML `null` values.

## Forge Paper Note paper reading

The automated paper task uses the repository-bundled `forge-paper-note` skill
exclusively. Install the bundled skills from the repository root, then verify the
active local installation before processing papers:

```bash
python3 scripts/check-forge-paper-note.py
```

The versioned source is `skills/forge-paper-note/`. The check requires its installed
copy at `$CODEX_HOME/skills/forge-paper-note/`, including the deterministic figure,
lint, and save scripts. Set `forge_python_path` in `config.json` to a Python 3.10+
interpreter; the runner passes that exact interpreter to unattended Forge tasks.

Forge literature context is intentionally local-only: the prior-work section may
summarize only how the current paper describes its cited works. It does not search the
web or open cited papers, every entry is marked as not independently verified, and
follow-up novelty remains unresolved without external literature calibration.

## Optional continuous Mode A intensive reading

Every primary paper note exposes two human-owned Obsidian checkboxes:
`paragraph_reading` and `paragraph_reading_figures`. The first opts a valuable paper
into interactive full-text reading; the second authorizes persistence of selected
image crops. Scientific figures, tables, and equations remain part of reasoning
coverage even when crop persistence is disabled. Neither option runs automatically.

After checking `paragraph_reading`, open that primary note and run the Obsidian command
`开始或继续当前论文的交互式全文精读`. The runner invokes the repository-bundled,
locally installed `paper-intensive-reading` skill. It uses the MinerU page-delimited
Markdown as its navigation/evidence layer, consolidates the whole paper into
non-overlapping reasoning units, and writes a separate process log at
`wiki/papers/close-reading/<exact-primary-note-filename>`. Each invocation advances
one user/AI interaction stage and then stops. Both files share the paper's existing
`wiki/papers/images/<exact-note-stem>/` asset directory.

The primary paper note is the paper's sole integration source. The process log carries
`integration_role: auxiliary` and `primary_source_id`, and the runner rejects attempts
to integrate it directly. Normal reading actions cannot change the primary-note body.
Only a unit scoring at least 6/8 without major factual error becomes `ready_to_merge`;
the separate `paragraph-merge` action then adds a compact verification, correction, or
non-duplicate increment with exact PDF-page evidence. Canonical knowledge remains
unchanged until the primary note is reviewed and passed through normal integration.

Verify the optional local skill before first use:

```bash
python3 scripts/check-paper-intensive-reading.py
```

Set `paragraph_reading_skill` to `paper-intensive-reading`. Each invocation is capped
by `paragraph_reading_timeout_seconds`, which defaults to 1800 seconds.

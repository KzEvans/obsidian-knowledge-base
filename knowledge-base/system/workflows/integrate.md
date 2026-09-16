# Reviewed-note integration workflow

Integrate exactly the supplied `NOTE_PATH`. The note must already have `status: reviewed`.

The runner also requires `reviewed: true`, a matching
`reviewed_content_sha256`, no open human-review checkboxes, and explicit acceptance
of remaining validation warnings. An integration command cannot grant approval.

`wiki/papers/close-reading/` contains auxiliary intensive-reading logs. Never
integrate those files directly. A scored, verified unit must first pass the separate
explicit merge gate; its corrections or non-duplicative increments then become part
of the linked primary paper note. That primary note remains the paper's only
integration source.

## Safety boundary

- Never modify `sources/`, `extracts/`, `笔记/实验笔记/`, or `system/queue/pending.json`.
- Do not silently resolve contradictions. Record competing evidence and its conditions.
- Do not remove human review comments.
- Every scientific claim added to a canonical wiki page must link back to the reviewed note and, for papers, to a PDF page.

## Canonical page rules

Canonical knowledge lives in:

- `wiki/concepts/`
- `wiki/materials/`
- `wiki/methods/`
- `wiki/phenomena/`
- `wiki/projects/`
- `wiki/questions/`
- `wiki/synthesis/`

Create a new canonical page only when at least one condition holds:

1. the subject appears in two or more reviewed sources;
2. it is a core variable in the user's research;
3. it directly connects a paper to an experiment note;
4. competing evidence needs an explicit comparison page.

Otherwise, keep the candidate association in the reviewed note without creating an empty page.

## Integration operations

1. Read `wiki/index.md` and search existing wiki pages before creating anything.
2. Update relevant canonical pages with concise, source-bound evidence.
3. Use evidence tables where useful: claim, conditions, direction/effect, source, confidence.
4. Add bidirectional Obsidian links between the reviewed note and canonical pages.
5. Record support, qualification, or contradiction explicitly.
6. Add unresolved gaps to an existing question page or a justified new page in `wiki/questions/`.
7. Move the note's entry from `## 待审核草稿` to `## 已整合来源` in `wiki/index.md`.
8. Change the reviewed note frontmatter to `status: integrated`, `reviewed: true`, and add `integrated_at`.

Canonical pages should normally contain: current understanding, mechanism or definition, evidence, limiting/contradictory evidence, linked papers, linked experiments, and open questions.

## Claim identity and duplicate prevention

- `CLAIMS_JSON` supplies source-specific `claim_id`, stable `paper_identity`, PDF
  attachment hash, statement including conditions, and page evidence. Record the
  ID as `<!-- kb-claim:<claim_id> -->` next to its evidence row or paragraph.
- Search existing canonical pages for the ID before adding a claim. The same
  primary paper, its intensive-reading log and a revised attachment are not three
  independent sources. Count unique `paper_identity` values, not files.
- Exact claim IDs support mechanical repeat detection, not semantic proof.
  For paraphrases, inspect conditions, quantities and evidence before deciding
  whether they repeat, support, qualify, correct or contradict an existing claim.
- A corrected claim gets an explicit `corrects:<old-claim-id>` relation; keep the
  previous conditioned claim and source history. Do not silently replace evidence.
- Start with a small synthesis of two human-reviewed primary sources when
  available. Never approve existing drafts just to satisfy this threshold.

Finish with JSON matching `system/knowledge/result.schema.json`, using `operation: integrate` and `status: integrated`.

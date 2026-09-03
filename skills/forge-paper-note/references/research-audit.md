# Research Audit

Read this file for every note run. Use it to add active research reasoning without turning the note into a repetitive checklist.

All literature context in this audit is local-source-only. Use the current target
paper's prose and reference list; never search the web or open cited papers. Every
prior-work summary is an attribution to the current paper, not an independently
verified conclusion.

## Table of contents

1. Planning contract
2. Required subsections
3. Analysis rules
4. Preparation protocol contract
5. Question-answer and inference contracts
6. Paper-type adaptation
7. Follow-up novelty gate
8. Candidate-entity contract
9. Readability rules

## 1. Planning contract

Extend the ordinary grounded `note_plan` with these compact fields:

```json
{
  "output_language": "zh-CN",
  "central_claim": "The single claim whose truth makes the paper worth keeping.",
  "decisive_evidence": [
    {
      "claim": "...",
      "source_pages": [6, 7],
      "test_or_argument": "...",
      "observed_answer": "...",
      "proves": "...",
      "does_not_prove": "..."
    }
  ],
  "strongest_comparison": "Strongest baseline, prior route, or competing explanation.",
  "prior_work_matrix": [
    {
      "work": "Closest cited work",
      "source_identifier": "Reference number and any DOI/title printed in the current paper",
      "existing_conclusion": "What the current paper attributes to that work",
      "why_insufficient": "Why the current paper says it still does not answer the present question",
      "verification_status": "paper_characterization_only"
    }
  ],
  "reasoning_path": [
    "Pre-existing failure mode or observation",
    "Constraint inferred from prior knowledge",
    "Design question that follows",
    "Idea that resolves the constraint"
  ],
  "core_intuition": "Two to four ordinary-language sentences.",
  "inference_ledger": [
    {
      "inference": "A useful interpretation not explicitly stated by the authors",
      "basis": "Observable result, comparison, formula, or page",
      "boundary": "What this inference cannot establish",
      "target_section": "Where it should appear beside its evidence"
    }
  ],
  "question_answer_map": [
    {
      "question": "Major research question or hypothesis",
      "test_or_evidence": "Experiment, comparison, or argument",
      "answer": "Observed answer",
      "confidence_and_gap": "Strength of answer and what remains unresolved"
    }
  ],
  "domain_adaptation": {
    "material_preparation_required": false,
    "reason": "Why a stepwise preparation protocol is or is not required"
  },
  "preparation_steps": [
    {
      "step": "Step name",
      "inputs": "Materials and quantities",
      "conditions": "Time, temperature, concentration, atmosphere, rate, or instrument setting",
      "operation": "Action performed",
      "output": "Intermediate or final state",
      "critical_control": "Variable that must be held fixed or checked"
    }
  ],
  "fragile_assumption": {
    "assumption": "...",
    "failure_cost": "...",
    "evidence_for": "...",
    "missing_test": "..."
  },
  "minimal_reproduction": {
    "claim": "...",
    "inputs": "...",
    "implementation": "...",
    "measurement": "...",
    "support_threshold": "...",
    "refutation_threshold": "..."
  },
  "strongest_counterexample": {
    "alternative_explanation": "...",
    "isolating_intervention": "...",
    "result_that_hurts_the_paper": "..."
  },
  "followup": {
    "driving_gap": "Fragile assumption or unmet need that motivates the idea",
    "new_framing": "...",
    "adjacent_field": "...",
    "borrowed_tool": "...",
    "technical_route": "...",
    "first_experiment": "...",
    "expected_support_signal": "...",
    "falsification_signal": "...",
    "key_risk": "...",
    "novelty_status": "unresolved"
  },
  "candidate_entity_inventory": [
    {
      "entity": "Stable technical noun",
      "type": "concept | material | method | mechanism | metric | device | phenomenon | failure_mode | dataset | theory | task | application",
      "relation": "How the entity participates in this paper",
      "link_target": "Canonical or proposed wiki target",
      "selection_reason": "Why linking it improves cross-paper retrieval"
    }
  ],
  "review_items": ["Internal inconsistency or evidence still requiring a human"]
}
```

Keep the plan inspectable. Do not emit hidden chain-of-thought or a long free-form reasoning transcript.

## 2. Required subsections

Use these exact headings for `zh-CN`. In ordinary vault/workspace runs, nest them inside the canonical DeepPaperNote top-level sections.

If a pipeline repository mandates numbered PaperForge headings such as `## 1. 研究问题与重要性`, follow that exact top-level order. Treat the headings below as required analytical concepts: numbered prefixes are acceptable, and missing concepts may be added as `###` subsections without changing the repository's required `##` sequence.

### Under `## 研究问题`

- `### 前人工作与不足`
- `### 重建作者的思考路径`
- `### 核心 Intuition`

### Under `## 方法主线`

- `### 机制流程` for method, framework, system, and mechanism papers
- `### 材料制备步骤` for materials, chemistry, fabrication, wet-lab, device-processing, or sample-preparation papers
- `### 核心数学推导` when formalism is central; omit only when genuinely inapplicable

### Under `## 关键结果`

- `### 实验设计与结论`
- `### 问题—证据—回答`
- Add paper-specific result subsections and a compact comparison table when useful.

### Under `## 深度分析`

- `### 真正贡献是什么`
- `### 证据真正证明了什么`
- `### 最脆弱的假设`
- `### 最强反例设计`
- `### 哪些地方容易被误读`

### Under `## 我的笔记`

- `### Take-aways`
- `### 最小复现实验`
- `### Follow-up Research Idea`
- `### 可复用的设计原则` when the paper supports one

### Before `## 引用`

- `## 与现有知识的候选关联`
- `## 可验证的知识声明`
- `## 人工复核`

Use these English equivalents for `en`:

- `Prior Work and Its Limits`
- `Reconstructing the Authors' Reasoning Path`
- `Core Intuition`
- `Mechanism Flow`
- `Material Preparation Steps`
- `Core Mathematical Derivation`
- `Experimental Design and Conclusions`
- `Question-Evidence-Answer Map`
- `What the Real Contribution Is`
- `What the Evidence Actually Proves`
- `Most Fragile Assumption`
- `Strongest Counterexample`
- `Easy Misreadings`
- `Takeaways`
- `Minimal Reproduction`
- `Follow-up Research Idea`
- `Reusable Design Principle`
- `Candidate Knowledge Links`
- `Verifiable Claims`
- `Human Review`

## 3. Analysis rules

### Research problem and prior work

- Select two to five closest works actually cited by the paper; prioritize the references that carry the main theoretical premise, strongest prior capability, or closest competing route.
- Use only the current paper's description and printed bibliography entry. Do not resolve identifiers, open original sources, or run any network search.
- State the conclusion as an attribution: “the current paper describes [reference] as showing ...”. Cite the current paper page and printed reference number, and set `verification_status` to `paper_characterization_only`.
- Identify the type of insufficiency: invalid assumption, mechanism limit, engineering cost, evaluation gap, missing evidence, or changed problem framing.
- Do not claim independently established novelty. Write `仅依据本文转述，未独立核验；未进行外部文献检索` / `based only on the current paper's characterization; not independently verified; no external literature search performed`.
- Prefer a compact matrix with columns `work/source`, `existing conclusion`, `remaining gap`, and `verification status` when three or more prior works are central.

### Reconstructing the reasoning path

- Use only knowledge available before the paper's contribution: known failure modes, empirical observations, theoretical clues, and prior work.
- Reconstruct a plausible path, not the authors' private historical thought process. Label it as inference.
- End at the design question that makes the paper's idea a natural candidate.

### Core intuition and mechanism

- Express the intuition in two to four sentences without formal notation.
- Explain the full pipeline with concrete input, operation, and output destination.
- Distinguish standard components from paper-specific components.
- Retain only formulas necessary for understanding the claim; explain the operation or physical meaning after each one.

### Experiment and evidence chain

For each major claim, write:

`question or hypothesis -> experiment, comparison, or argument -> observed answer -> conclusion boundary`

- Include three to six decisive numbers, not every reported metric.
- Include one negative result, failed condition, trade-off, null result, or explicitly missing test.
- Distinguish measured values, calculated values, graph-read estimates, and author interpretation.
- When multiple systems or conditions are central, use a table and interpret it immediately afterward.

## 4. Preparation protocol contract

When `domain_adaptation.material_preparation_required` is true, write `### 材料制备步骤` / `### Material Preparation Steps` as a numbered operational sequence.

- Preserve author order. Do not merge steps that change composition, phase, atmosphere, geometry, or thermal/mechanical history.
- For every step, state inputs and quantities, operating conditions, action, output state, and one critical control. Use `not reported` when a reproducibility-critical value is absent; never infer it.
- Separate precursor synthesis, surface treatment, formulation/mixing, shaping/casting, post-treatment, specimen preparation, and device assembly when they are distinct.
- Distinguish a preparation step from a characterization or evaluation step.
- Add a compact process table only when it improves comparison across sample groups; the numbered sequence remains the primary reproduction artifact.

## 5. Question-answer and inference contracts

### Question-evidence-answer map

- Under `### 问题—证据—回答`, map every major research question to the decisive test or argument, observed answer, confidence, and unresolved remainder.
- Keep the question phrased independently of the answer. A result heading is not a research question.
- Include negative answers and partial answers; do not force every hypothesis to succeed.
- Make the conclusion section answer the questions introduced earlier instead of merely repeating peak metrics.

### Evidence-based inference

- Add one to five non-obvious inferences when the evidence supports them. Place each beside the relevant method, result, or limitation paragraph.
- Begin with `推断：` / `Inference:` and name the observable basis. End with the boundary or plausible alternative.
- Good inferences explain a trend, connect two pieces of evidence, identify a likely mechanism, or expose what a result implies for transferability.
- Do not relabel author claims as inference, and do not write inference when the evidence cannot distinguish the proposed explanation from obvious alternatives.

### Fragile assumption

- Select one assumption whose failure most damages the central contribution.
- State why it can fail in realistic conditions.
- State evidence the paper provides and the decisive matched control, measurement, or argument it omits.
- Do not substitute a generic limitation list.

### Minimal reproduction

- Fit the experiment to roughly one week and one falsifiable claim.
- Name data/materials, independent replicates or seeds, implementation, measurements, and uncertainty reporting.
- Define in advance what result supports and what result refutes the claim.
- Avoid reproducing the full system when a narrower causal or mechanical test is more diagnostic.

### Strongest counterexample

- Attack the preferred causal or explanatory account, not an irrelevant edge case.
- Propose a matched control or predictable failure condition that separates it from a plausible alternative.
- State the result that would materially weaken the paper and the result that would strengthen it.

## 6. Paper-type adaptation

- **AI method/system:** focus on training/inference mechanism, strongest baseline, ablation logic, compute/latency, distribution shift, and implementation fragility.
- **Benchmark/dataset:** focus on construct validity, sampling, label/annotation protocol, leakage, coverage, access, and whether baselines show difficulty or protocol adaptation.
- **Materials/engineering:** focus on composition, controls, processing history, characterization, structure-property chain, reliability, uncertainty, scale-up, and device boundary conditions.
- **Clinical/psychology:** focus on cohort, inclusion/exclusion, measurement validity, confounding, multiplicity, effect size, uncertainty, causal boundary, and external validity.
- **Humanities/social science:** focus on corpus/case selection, conceptual distinctions, inferential steps, counter-reading, alternative explanation, and transferability.
- **Survey/review:** focus on search scope, inclusion/exclusion, taxonomy, evidence weighting, omitted regions, disagreements, and whether the taxonomy has explanatory power.

## 7. Follow-up novelty gate

Do not invent novelty by rhetoric.

1. Derive the driving gap from the fragile assumption, negative result, or decisive missing measurement.
2. Do not search for same-field or adjacent-field work. Use only methods, tools, limitations, and future directions mentioned in the current paper.
3. State a new framing, objective, causal question, measurement target, or cross-field connection grounded in that local evidence. Reject ideas that only add a module, scale a dataset, or substitute a material without changing the research question.
4. Name an adjacent field or borrowed tool only if the current paper itself supplies that connection, then explain why its assumptions may fit.
5. Give a plausible technical route with the main representation, model, fabrication change, measurement, or control—not just a slogan.
6. Describe the first discriminating experiment, expected support signal, and explicit falsification signal.
7. Name the key technical or scientific risk and the fallback interpretation if the experiment fails.
8. Always mark novelty `unresolved` and state that no external literature search was performed; do not distinguish the proposal from work that was not locally supplied.

## 8. Candidate-entity contract

- Build an inventory of eight to sixteen link candidates before writing the section. Use fewer only with a paper-specific justification in Human Review.
- Cover at least four types where applicable: concept, material, method, mechanism, metric, device, phenomenon, failure mode, dataset, theory, task, or application.
- Prefer entities that recur across papers, control interpretation, or enable synthesis. Exclude author names, generic fields, one-off sample codes, and nouns that are too broad to support retrieval.
- For each `[[link target]]`, state the entity type, its relation to this paper, and why the connection matters.
- Search the vault for canonical spelling and aliases before proposing a new target. Candidate status does not authorize page creation.

## 9. Readability rules

- Do not prefix every paragraph with an evidence label. Use direct sourced prose plus page links for ordinary paper content.
- Use `推断：` / `Inference:` only when moving beyond explicit author claims.
- Use `假设：` / `Hypothesis:` for unsupported proposals.
- Avoid repeating the same result in Contributions, Takeaways, Verifiable Claims, and the result section with identical wording. Change the function of each occurrence or remove it.
- Make Verifiable Claims atomic and integration-ready; keep interpretation in Deep Analysis.
- Prefer a compact takeaway list over a 5/3/1 repetition stack unless explicitly requested.

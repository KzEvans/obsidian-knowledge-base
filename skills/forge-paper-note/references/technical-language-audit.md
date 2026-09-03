# Technical Language Audit

Read this file for every non-English note and for any paper whose protocol, symbols, units, or operational definitions are technically important. The purpose is not literal translation. It is to preserve the source's actor, object, operation, condition, measured quantity, and epistemic status in natural domain language.

## 1. Planning contract

Extend `note_plan` with the following fields before drafting:

```json
{
  "terminology_ledger": [
    {
      "source_term": "statistical average breakdown strength",
      "preferred_rendering": "特征击穿场强",
      "definition": "the field at 63.2% cumulative failure probability in the fitted Weibull model",
      "avoid": ["平均击穿强度"],
      "source_pages": [5]
    }
  ],
  "protocol_ledger": [
    {
      "step": "surface decoration",
      "source_action": "AAS was dissolved in the dispersion and ultrasonicated",
      "actor_or_object": "AAS and the ZrO2/THF dispersion",
      "quantity": "0.5 g AAS; dispersion prepared from 1 g ZrO2 and 9 g THF",
      "conditions": "second ultrasonication duration not reported",
      "operation": "dissolve and ultrasonicate",
      "output": "AAS-decorated-particle dispersion",
      "missing_fields": ["second ultrasonication duration"],
      "source_pages": [3]
    }
  ],
  "measurement_ledger": [
    {
      "quantity": "Weibull characteristic breakdown strength",
      "symbol": "E_b",
      "operational_definition": "field at 63.2% cumulative failure probability",
      "acquisition_type": "fitted",
      "unit": "V um^-1",
      "sample_basis": "20 random sites on each tested film; independent film count not reported",
      "source_pages": [5, 6]
    }
  ],
  "reported_unit_warnings": [
    {
      "reported_form": "0.15 V s^-1",
      "reason_for_review": "unusual for the described high-voltage breakdown ramp",
      "action": "preserve the printed unit and add a Human Review item; do not silently correct it"
    }
  ],
  "translation_review": {
    "source_target_alignment_checked": true,
    "quantities_and_units_checked": true,
    "operator_object_checked": true,
    "missing_values_not_filled": true,
    "measurement_types_labeled": true,
    "terminology_consistency_checked": true,
    "domain_heading_adapted": true,
    "review_notes": ["Any unresolved ambiguity or suspicious printed unit"]
  }
}
```

Allowed `measurement_ledger[].acquisition_type` values are:

- `measured`: direct instrument, observation, image, response, count, or recorded curve;
- `fitted`: parameter obtained by fitting a statistical or physical model;
- `derived`: quantity calculated from measurements, a formula, a slope, normalization, or transformation;
- `graph_read`: value estimated from a plot rather than printed in text or a table;
- `author_interpretation`: structural, mechanistic, or causal interpretation stated by the paper but not directly measured.

Use `not reported` for a missing symbol, unit, duration, replicate count, specimen basis, or control. Do not replace it with a conventional value from domain knowledge.

## 2. Protocol translation

Translate each protocol clause as an operational record:

`object and amount -> operation -> conditions -> resulting state`

- Preserve the source order. Split preparation, specimen preparation, characterization, device assembly, and evaluation when the source performs them separately.
- Keep the operator and object aligned. For example, `a film was stored in a vacuum oven` does not license `the polymer was vacuum-dried before casting`.
- Preserve whether a quantity describes a formulation, final sample, instrument setting, specimen geometry, environment, loading rate, voltage ramp, or analysis method.
- Do not turn `mixed by stirring` into a named high-shear process, or `slowly increased` into a numerical rate.
- If a parallel control's complete procedure is not stated, describe only the difference supported by the sample definition. Do not invent a mirrored protocol.
- Keep author-reported units exactly. When a unit is internally surprising, add it to `reported_unit_warnings` and Human Review instead of silently adding a prefix, converting the value, or declaring it correct.
- State the sampling unit precisely: sites on one film, independent films, specimens, devices, batches, images, fields of view, participants, runs, or seeds are not interchangeable.

For materials, chemistry, fabrication, and wet-lab papers, use these localized subsections under the fixed top-level data/task section:

- `### 材料与样品命名` / `### Materials and Sample Names`
- `### 材料制备步骤` / `### Material Preparation Steps`
- `### 表征与测试条件` / `### Characterization and Test Conditions`
- `### 研究对象与关键对照` / `### Study Objects and Key Comparisons`
- `### 评价量与获取方式` / `### Quantities and How They Were Obtained`

Do not write `任务与评价量` or explain that the paper is “not a public dataset task.” The fixed top-level heading is a storage schema, not domain vocabulary.

## 3. Quantity and metric translation

For every decisive quantity, record all of the following when available:

1. source term and preferred rendering;
2. symbol and unit;
3. operational definition;
4. acquisition type;
5. specimen or sampling basis;
6. whether the note's number is printed, graph-read, or inferred;
7. what conclusion the quantity can and cannot support.

Never collapse these categories:

- a recorded breakdown event versus Weibull-fitted `E_b` and `beta`;
- a stress-stretch curve versus modulus derived from its initial slope;
- image-derived area strain versus directly measured displacement;
- a formula-calculated energy density versus measured net work, efficiency, or blocking force;
- a dimensionless ranking proxy versus a device output;
- two-dimensional co-location in a micrograph versus complete three-dimensional confinement.

Use the source's technical definition rather than the most familiar dictionary translation. A symbol can retain its original form while the Chinese label explains its operational meaning.

## 4. Terminology consistency

- Create the terminology ledger while reading methods, equations, figure captions, and results—not after prose has already drifted.
- Prefer natural Chinese followed by the source term on first mention when that helps disambiguation.
- Keep one preferred rendering for each recurring quantity, material, process, phase, specimen, and failure mode.
- Reserve stronger causal verbs for evidence that excludes plausible alternatives. Translate `suggest`, `ascribe`, `likely`, and `indicate` with the same uncertainty.
- Preserve distinctions such as characteristic/statistical value, maximum/stable value, nominal/true field, stress/stretch/strain, weight fraction/concentration, and sample/site/batch.

## 5. Final bilingual audit

Before linting, reread the source clauses beside the drafted protocol and metric sections. Check:

- every number, unit, duration, temperature, rate, concentration, geometry, and replicate basis;
- every action's object and resulting state;
- every missing value remains explicitly missing;
- every decisive quantity is labeled measured, fitted, derived, graph-read, or author interpretation;
- repeated terms use the ledger's preferred rendering;
- suspicious source wording is preserved and queued for human review;
- subsection labels sound native to the paper's domain.

Run `scripts/lint_technical_language.py --input <note> --plan-file <note_plan> --require-plan` after this audit. Passing lint verifies that the audit artifact exists and is internally aligned; it does not replace source comparison.

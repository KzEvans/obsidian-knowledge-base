import json
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY = Path(__file__).resolve().parents[1]
SCRIPT_DIR = REPOSITORY / "skills" / "forge-paper-note" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import lint_note  # noqa: E402
import lint_technical_language  # noqa: E402


class ForgeLintContractTest(unittest.TestCase):
    def tearDown(self):
        lint_note.configure_output_language("zh-CN", "canonical")

    def test_pipeline_plan_uses_forge_research_audit_contract(self):
        plan = {
            "output_language": "zh-CN",
            "central_claim": "A paper-specific central claim.",
            "decisive_evidence": [{"claim": "Claim", "source_pages": [1]}],
            "strongest_comparison": "The strongest comparison.",
            "prior_work_matrix": [{"work": "Ref. 1"}],
            "reasoning_path": ["Observation", "Constraint", "Question", "Idea"],
            "core_intuition": "A compact intuition.",
            "inference_ledger": [{"inference": "Inference"}],
            "question_answer_map": [{"question": "Question"}],
            "candidate_entity_inventory": [{"entity": "Entity"}],
            "review_items": ["Review this ambiguity."],
        }
        lint_note.configure_output_language("zh-CN", "pipeline-paperforge")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "note-plan.json"
            path.write_text(json.dumps(plan), encoding="utf-8")
            found, issues = lint_note.inspect_note_plan(path, "zh-CN")
        self.assertTrue(found)
        self.assertEqual(issues, [])

    def test_canonical_plan_keeps_deeppapernote_contract(self):
        plan = {
            "output_language": "zh-CN",
            "paper_type": "AI_method",
            "paper_type_rationale": "The paper introduces an AI method.",
            "dominant_domain": "machine learning",
            "must_cover": ["Method"],
            "key_numbers": ["42"],
            "real_comparisons": ["Baseline"],
            "central_claims": [
                {
                    "claim": "Claim",
                    "supporting_evidence": ["p.1"],
                    "what_it_actually_proves": "Supported scope",
                    "what_it_does_not_prove": "Unsupported scope",
                }
            ],
            "claim_boundaries": ["Boundary"],
            "negative_or_limiting_results": ["Limitation"],
            "mechanism_result_map": ["Mechanism to result"],
            "comparative_positioning": ["Positioning"],
            "reuse_takeaways": ["Takeaway"],
            "followup_questions": ["Question"],
            "section_plan": ["Section"],
        }
        lint_note.configure_output_language("zh-CN", "canonical")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "note-plan.json"
            path.write_text(json.dumps(plan), encoding="utf-8")
            found, issues = lint_note.inspect_note_plan(path, "zh-CN")
        self.assertTrue(found)
        self.assertEqual(issues, [])

    def test_numbered_list_is_not_a_mid_sentence_linebreak(self):
        text = "1. 第一项没有句号\n2. 第二项也没有句号\n"
        self.assertEqual(lint_note.suspicious_mid_sentence_linebreaks(text), [])

    def test_pipeline_reference_entry_may_retain_english_title(self):
        lint_note.configure_output_language("zh-CN", "pipeline-paperforge")
        text = (
            "## 引用\n\n"
            "- 目标论文：Author. Confining Particles in Nanodomains Leads to Large Deformation。\n"
        )
        self.assertEqual(lint_note.mixed_language_issues(text), [])

    def test_material_preparation_is_domain_native_method_flow(self):
        lint_note.configure_output_language("zh-CN", "pipeline-paperforge")
        text = (
            "## 5. 具体方法与完整 Pipeline\n\n"
            "### 材料制备步骤\n\n"
            "1. 输入原料并混合。\n"
            "2. 在 80 °C 下反应。\n"
            "3. 输出并测试样品。\n"
        )
        self.assertEqual(lint_note.mechanism_flow_warnings(text), [])

    def test_reported_unit_matches_superscript_notation(self):
        review = "核对原文印刷的 `0.15 V s⁻¹` 是否漏写前缀。"
        self.assertTrue(
            lint_technical_language.reported_form_present("0.15 V s^-1", review)
        )
        self.assertFalse(
            lint_technical_language.reported_form_present(
                "0.15 V s^-1", "核对另一项实验条件。"
            )
        )


if __name__ == "__main__":
    unittest.main()

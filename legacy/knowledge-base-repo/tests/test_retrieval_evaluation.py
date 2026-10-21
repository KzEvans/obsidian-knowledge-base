"""Synthetic relevance cases test evaluation without private source fixtures."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest


PATH = Path(__file__).resolve().parents[1] / "scripts/evaluate-knowledge-retrieval.py"
SPEC = importlib.util.spec_from_file_location("retrieval_evaluation", PATH)
E = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(E)


class RetrievalEvaluationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.vault = Path(self.temp.name)
        for name in ("A", "B", "C", "D", "Extra"):
            note = self.vault / f"wiki/papers/{name}.md"
            note.parent.mkdir(parents=True, exist_ok=True)
            note.write_text("---\ntype: paper\nstatus: draft\n---\n# Synthetic note")
        user_note = self.vault / "wiki/papers/User.md"
        user_note.write_text("# A user record")

    def engine(self, mapping):
        def context(vault, question, anchor, *, limit):
            self.assertEqual(limit, 4)
            value = mapping[question]
            if isinstance(value, Exception):
                raise value
            return {"results": [{"note_path": f"wiki/papers/{name}.md", "title": name, "status": "draft"} for name in value], "warnings": []}
        return SimpleNamespace(knowledge_context=context)

    def test_all_cases_include_improvement_regression_negative_failure_and_user_records(self):
        cases = [
            {"id": "up", "question": "up", "expected_notes": ["wiki/papers/A.md", "wiki/papers/B.md"], "expected_empty": False},
            {"id": "down", "question": "down", "expected_notes": ["wiki/papers/C.md"], "expected_empty": False},
            {"id": "negative", "question": "negative", "expected_notes": [], "expected_empty": True},
        ]
        before = self.engine({"up": ["Extra", "A"], "down": ["C"], "negative": []})
        after = self.engine({"up": ["A", "B"], "down": ["User"], "negative": RuntimeError("failed")})
        report = E.evaluate(cases, self.vault, before, after)
        self.assertEqual(len(report["cases"]), 3)
        self.assertEqual(report["cases"][0]["baseline"]["recall_at_4"], 0.5)
        self.assertEqual(report["cases"][0]["baseline"]["first_expected_rank"], 2)
        self.assertEqual(report["cases"][0]["current"]["rr_at_4"], 1)
        self.assertEqual(report["changes"], {"improved": 1, "unchanged": 0, "regressed": 2, "mixed": 0})
        self.assertEqual(report["summary"]["current"]["negative_empty_accuracy"], 0)
        self.assertEqual(report["summary"]["current"]["user_record_or_untyped_hits"], 1)
        text = E.markdown_report(report)
        for case in cases:
            self.assertIn("## " + case["id"], text)
        self.assertIn("退步", text)
        self.assertIn("检索错误", text)

    def test_rank_limit_and_mixed_changes_are_not_called_improvements(self):
        case = {"id": "mixed", "question": "mixed", "expected_notes": ["wiki/papers/A.md", "wiki/papers/B.md"], "expected_empty": False}
        before = self.engine({"mixed": ["A"]})
        after = self.engine({"mixed": ["Extra", "A", "B", "C", "D"]})
        row = E.evaluate([case], self.vault, before, after)["cases"][0]
        self.assertEqual(row["change"], "mixed")
        self.assertEqual(len(row["current"]["top4"]), 4)

    def test_case_loader_keeps_declared_empty_cases_and_rejects_inconsistent_labels(self):
        path = self.vault / "cases.json"
        path.write_text(json.dumps({"version": 1, "cases": [{"question": "none", "expected_notes": [], "expected_empty": True}]}))
        cases, metadata = E.load_cases(path, self.vault)
        self.assertTrue(cases[0]["expected_empty"])
        self.assertEqual(metadata["version"], 1)
        path.write_text(json.dumps([{ "question": "bad", "expected_notes": ["wiki/papers/A.md"], "expected_empty": True }]))
        with self.assertRaises(ValueError):
            E.load_cases(path, self.vault)

    def test_baseline_is_an_explicit_local_module(self):
        path = self.vault / "controlled.py"
        path.write_text("def knowledge_context(vault, question, anchor, limit):\n    return {'results': [], 'warnings': []}\n")
        baseline = E.load_baseline(path)
        self.assertEqual(baseline.knowledge_context(self.vault, "q", None, limit=4)["results"], [])
        with self.assertRaises(FileNotFoundError):
            E.load_baseline(self.vault / "missing.py")


if __name__ == "__main__":
    unittest.main()

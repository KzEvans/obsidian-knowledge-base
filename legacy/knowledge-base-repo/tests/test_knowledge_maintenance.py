"""Read-only maintenance fixtures use the pipeline's actual claim builder."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1] / "knowledge-base/system/knowledge"
SPEC = importlib.util.spec_from_file_location("maintenance_pipeline", ROOT / "run_pipeline.py")
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)
SPEC = importlib.util.spec_from_file_location("knowledge_maintenance", ROOT / "knowledge_maintenance.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class KnowledgeMaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.vault = Path(self.temporary.name)

    def write(self, relative, content):
        path = self.vault / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode())
        return path

    def source(self, name, *, reviewed=True, version=True, experiment=False,
               doi=None, raw_path=None, statement=None, title=None):
        note_path = ("wiki/experiments/" if experiment else "wiki/papers/") + name + ".md"
        original = raw_path or (("笔记/实验笔记/" + name + ".md") if experiment
                                else "sources/literature/pdf/" + name + ".pdf")
        locator = "#Results" if experiment else "#page=2"
        if not (self.vault / original).exists():
            self.write(original, "# Results\nStress relaxation observations at 25 C.\n")
        actual_version = hashlib.sha256((self.vault / original).read_bytes()).hexdigest()
        paper_doi = doi or "10.1234/" + name
        normalized_doi = paper_doi.removeprefix("https://doi.org/").casefold()
        kind = "experiment" if experiment else "paper"
        source_identity = "experiment:" + name if experiment else "paper:" + name
        fields = {
            "type": kind, "title": title or "Stress relaxation " + name,
            "status": "reviewed" if reviewed else "draft", "reviewed": reviewed,
            "validation_status": "passed", "validation_warnings": [],
            "source_id": source_identity + ":version", "concepts": ["应力松弛"],
            "source_note" if experiment else "source_pdf": "[[" + original + "]]",
        }
        if not experiment:
            fields.update(doi=paper_doi, paper_identity="doi:" + normalized_doi)
        if version:
            fields["source_sha256"] = actual_version
        statement = statement or f"At 25 C, stress relaxation of {name} depends on loading at 0.1 s^-1."
        body = f"# {fields['title']}\n\n## 可验证的知识声明\n\n- {statement} [[{original}{locator}\\|原始证据]]\n"
        if reviewed:
            body += "\n## 人工复核\n\n- [x] Conditions and source checked.\n"
        def render():
            return "---\n" + "\n".join(f"{key}: {json.dumps(value, ensure_ascii=False)}"
                                         for key, value in fields.items()) + "\n---\n" + body
        text = render()
        if reviewed:
            fields["reviewed_content_sha256"] = P.review_content_hash(text)
            text = render()
        self.write(note_path, text)
        return note_path, original, {
            "id": fields["source_id"], "kind": kind, "note_path": note_path,
            "source_identity": source_identity, "source_path": original,
            "sha256": actual_version if version else None,
            "paper_identity": "doi:" + normalized_doi if not experiment else None,
        }

    def question(self, name, body, *, status="open", title="应力松弛的实验条件如何比较"):
        path = "wiki/questions/" + name + ".md"
        self.write(path, f'---\ntype: question\ntitle: "{title}"\nquestion_status: {status}\n---\n'
                   f'# {title}\n\n{body}\n\n'
                   '<!-- user-notes:start -->\nHuman question annotation.\n<!-- user-notes:end -->\n')
        return path

    def comparison(self, note=None, queue=(), limit=6, question="应力松弛 stress relaxation"):
        return M.collect_comparison(self.vault, question, note, P.claim_records, queue, limit)

    def snapshot(self):
        return {path.relative_to(self.vault).as_posix(): path.read_bytes()
                for path in self.vault.rglob("*") if path.is_file()}

    def test_two_independent_reviewed_current_sources_preserve_original_conditions(self):
        first, _, first_task = self.source("A", statement="At 25 C and strain rate 0.1 s^-1, A relaxes in 5 s.")
        second, _, second_task = self.source("B", statement="At 130 C and strain rate 1 s^-1, B relaxes in 20 s.")
        before = self.snapshot()
        with mock.patch.object(P, "codex_command") as model, mock.patch.object(P, "run_process") as process:
            result = self.comparison(first, [first_task, second_task])
            model.assert_not_called()
            process.assert_not_called()
        self.assertTrue(result["can_integrate"])
        self.assertEqual(result["eligible_source_count"], 2)
        self.assertEqual({source["note_path"] for source in result["sources"]}, {first, second})
        self.assertEqual(len(result["eligible_claims"]), 2)
        self.assertEqual(result["draft_claims"], [])
        for source in result["sources"]:
            self.assertEqual(set(source), {"note_path", "title", "kind", "identity", "status",
                                          "reviewed", "evidence_current", "claims", "warnings",
                                          "source_path", "source_version"})
            expected = P.claim_records((self.vault / source["note_path"]).read_text(),
                                       first_task if source["note_path"] == first else second_task)
            self.assertEqual(source["claims"], expected)
        markdown = M.comparison_markdown(result)
        self.assertIn("25 C and strain rate 0.1 s^-1", markdown)
        self.assertIn("130 C and strain rate 1 s^-1", markdown)
        self.assertIn("#page=2", markdown)
        self.assertIn("关系", markdown)
        self.assertIn("待核验", markdown)
        self.assertTrue(all(claim["relationship"] == "待核验" for claim in result["eligible_claims"]))
        self.assertEqual(self.snapshot(), before)

    def test_unreviewed_or_stale_review_claims_do_not_meet_integration_gate(self):
        anchor, _, _ = self.source("A")
        self.source("draft", reviewed=False)
        stale, _, _ = self.source("stale")
        path = self.vault / stale
        path.write_text(path.read_text() + "An addition after review.\n")
        result = self.comparison(anchor)
        self.assertFalse(result["can_integrate"])
        self.assertEqual(result["eligible_source_count"], 1)
        self.assertEqual(len(result["draft_claims"]), 2)
        self.assertTrue(any("审核" in warning for warning in result["warnings"]))

    def test_version_absent_changed_source_and_missing_evidence_remain_ineligible(self):
        first, _, _ = self.source("no-version", version=False)
        changed, original, _ = self.source("changed")
        self.write(original, "Changed original source")
        missing, original, _ = self.source("missing")
        (self.vault / original).unlink()
        result = self.comparison(first)
        self.assertEqual(result["eligible_source_count"], 0)
        self.assertFalse(result["can_integrate"])
        sources = {source["note_path"]: source for source in result["sources"]}
        self.assertFalse(sources[first]["evidence_current"])
        self.assertFalse(sources[changed]["evidence_current"])
        self.assertFalse(sources[missing]["evidence_current"])
        self.assertIn("来源版本未记录", " ".join(sources[first]["warnings"]))
        self.assertIn("已变化", " ".join(sources[changed]["warnings"]))
        self.assertIn("缺失", " ".join(sources[missing]["warnings"]))

    def test_doi_duplicates_do_not_count_twice_and_auxiliary_pages_are_ignored(self):
        first, _, _ = self.source("A", doi="10.1234/SAME")
        self.source("A-copy", doi="https://doi.org/10.1234/same")
        for path in ["wiki/papers/close-reading/extra.md", "wiki/papers/images/extra.md",
                     "wiki/papers/index.md", "wiki/papers/论文索引.md"]:
            self.write(path, (self.vault / first).read_text())
        result = self.comparison(first)
        self.assertEqual(result["eligible_source_count"], 1)
        self.assertEqual([source["note_path"] for source in result["sources"]], [first])
        self.assertFalse(result["can_integrate"])

    def test_queue_metadata_precedes_frontmatter_and_input_queue_is_unchanged(self):
        first, original, task = self.source("A", version=False)
        task["sha256"] = hashlib.sha256((self.vault / original).read_bytes()).hexdigest()
        queued = [dict(task)]
        before = json.dumps(queued, sort_keys=True)
        result = self.comparison(first, queued)
        self.assertTrue(result["sources"][0]["evidence_current"])
        self.assertEqual(result["sources"][0]["claims"],
                         P.claim_records((self.vault / first).read_text(), task))
        self.assertEqual(json.dumps(queued, sort_keys=True), before)

    def test_refreshed_queue_version_cannot_revive_old_reviewed_statements(self):
        first, original, task = self.source("A")
        old_version = task["sha256"]
        old_claims = P.claim_records((self.vault / first).read_text(), task)
        self.source("B")
        self.write(original, "An updated source PDF after the note was reviewed.")
        task["sha256"] = hashlib.sha256((self.vault / original).read_bytes()).hexdigest()
        result = self.comparison(first, [task])
        source = next(source for source in result["sources"] if source["note_path"] == first)
        self.assertTrue(source["reviewed"])
        self.assertFalse(source["evidence_current"])
        self.assertEqual(source["source_version"], old_version)
        self.assertEqual(source["source_path"], original)
        self.assertEqual(source["claims"], old_claims)
        self.assertTrue(any("审核绑定版本不一致" in warning for warning in source["warnings"]))
        self.assertEqual(result["eligible_source_count"], 1)
        self.assertFalse(result["can_integrate"])
        self.assertNotIn(first, [claim["note_path"] for claim in result["eligible_claims"]])

    def test_queue_source_path_cannot_replace_reviewed_origin(self):
        first, original, task = self.source("A")
        queued = dict(task)
        other = "sources/literature/pdf/replacement.pdf"
        self.write(other, (self.vault / original).read_bytes())
        queued["source_path"] = other
        result = self.comparison(first, [queued])
        source = result["sources"][0]
        self.assertEqual(source["source_path"], original)
        self.assertEqual(source["source_version"], task["sha256"])
        self.assertFalse(source["evidence_current"])
        self.assertTrue(any("路径不一致" in warning for warning in source["warnings"]))
        self.assertEqual(source["claims"], P.claim_records((self.vault / first).read_text(), task))

    def test_unrecorded_version_is_a_stable_empty_string(self):
        first, original, _ = self.source("unrecorded", version=False)
        source = self.comparison(first)["sources"][0]
        self.assertEqual(source["source_path"], original)
        self.assertEqual(source["source_version"], "")
        self.assertFalse(source["evidence_current"])

    def test_experiment_original_markdown_locator_and_stable_identity(self):
        first, _, _ = self.source("Run", experiment=True)
        self.source("Paper")
        result = self.comparison(first)
        experiment = next(source for source in result["sources"] if source["kind"] == "experiment")
        self.assertEqual(experiment["identity"], "experiment:Run")
        self.assertEqual(experiment["claims"][0]["source_kind"], "experiment")
        self.assertEqual(experiment["claims"][0]["evidence"], ["笔记/实验笔记/Run.md#Results"])
        self.assertTrue(result["can_integrate"])

    def test_explicit_anchor_is_retained_when_its_text_does_not_match_question(self):
        first, _, _ = self.source("Anchor", title="Unrelated processing protocol",
                                  statement="A solvent casting condition is 2 h at 80 C.")
        self.source("Related")
        result = self.comparison(first, question="loading strain rate", limit=2)
        self.assertEqual(result["anchor_note"], first)
        self.assertEqual(result["sources"][0]["note_path"], first)
        self.assertLessEqual(len(result["sources"]), 2)

    def test_no_unrelated_papers_are_dumped_and_markdown_remains_small(self):
        first, _, _ = self.source("Relevant")
        for index in range(12):
            path = f"wiki/papers/unrelated-{index}.md"
            self.write(path, "---\ntitle: Astronomy optics\n---\n# Telescope\nGalactic observations.")
        result = self.comparison(first, limit=2)
        self.assertEqual([source["note_path"] for source in result["sources"]], [first])
        markdown = M.comparison_markdown(result)
        self.assertNotIn("Telescope", markdown)
        self.assertLess(len(markdown), 5000)

    def test_question_report_detects_review_expiry_missing_evidence_and_missing_source(self):
        stale, _, _ = self.source("stale")
        self.write(stale, (self.vault / stale).read_text() + "Post-review change")
        missing, original, _ = self.source("missing")
        (self.vault / original).unlink()
        question = self.question("Q", f"## 引用\n\n[[{stale}]] [[{missing}]] [[wiki/papers/Absent]]")
        before = self.snapshot()
        result = M.question_maintenance(self.vault, P.claim_records)
        entry = next(entry for entry in result["questions"] if entry["note_path"] == question)
        kinds = {issue["kind"] for issue in entry["issues"]}
        self.assertIn("source_review_invalid", kinds)
        self.assertIn("source_evidence_unavailable", kinds)
        self.assertIn("missing_source_note", kinds)
        self.assertEqual(self.snapshot(), before)

    def test_question_claim_markers_deduplicate_new_related_reviewed_claims(self):
        first, _, first_task = self.source("A")
        second, _, _ = self.source("B")
        self.source("draft", reviewed=False)
        claim_id = P.claim_records((self.vault / first).read_text(), first_task)[0]["claim_id"]
        self.question("Q", f"## 来源\n\n[[{first}]]\n\n<!-- kb-claim:{claim_id} -->")
        result = M.question_maintenance(self.vault, P.claim_records)
        new = result["questions"][0]["new_related_claims"]
        self.assertEqual([claim["note_path"] for claim in new], [second])
        self.assertNotIn(claim_id, [claim["claim_id"] for claim in new])
        self.assertTrue(all(claim["reviewed"] and claim["evidence_current"] for claim in new))

    def test_answer_without_source_is_flagged_and_human_question_status_is_preserved(self):
        self.question("Answered", "## 回答\n\nThe response always decreases.", status="answered")
        self.question("Closed", "The question was set aside by the user.", status="closed")
        before = self.snapshot()
        result = M.question_maintenance(self.vault, P.claim_records)
        answered = next(question for question in result["questions"] if question["status"] == "answered")
        self.assertIn("answer_without_source", {issue["kind"] for issue in answered["issues"]})
        closed = next(question for question in result["questions"] if question["status"] == "closed")
        self.assertNotIn("answer_without_source", {issue["kind"] for issue in closed["issues"]})
        markdown = M.question_maintenance_markdown(result)
        self.assertIn("answered（保留人类记录）", markdown)
        self.assertIn("closed（保留人类记录）", markdown)
        self.assertIn("不自动补答案", markdown)
        self.assertEqual(self.snapshot(), before)

    def test_question_report_checks_direct_original_links_and_unique_basename_alias(self):
        source, _, _ = self.source("Case", title="case")
        self.question("Q", "## 回答\n\nSource says so. [[case]] [[sources/missing.pdf#page=3]]")
        result = M.question_maintenance(self.vault, P.claim_records)
        entry = result["questions"][0]
        self.assertEqual([item["note_path"] for item in entry["referenced_sources"]], [source])
        kinds = {issue["kind"] for issue in entry["issues"]}
        self.assertIn("missing_original_evidence", kinds)
        self.assertNotIn("ambiguous_source_link", kinds)
        self.assertNotIn("answer_without_source", kinds)

    def test_maintenance_has_no_model_or_generation_side_effect(self):
        self.source("A")
        self.question("Q", "Question awaiting review.")
        self.write("system/knowledge/config.json", '{"ingest_paused": true}')
        before = self.snapshot()
        with mock.patch.object(P, "codex_command") as model, mock.patch.object(P, "ingest_next") as ingest:
            payload = M.question_maintenance(self.vault, P.claim_records)
            M.question_maintenance_markdown(payload)
            model.assert_not_called()
            ingest.assert_not_called()
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()

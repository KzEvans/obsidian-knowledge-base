import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

MODULE = Path(__file__).resolve().parents[1] / "knowledge-base/system/knowledge/run_pipeline.py"
spec = importlib.util.spec_from_file_location("pipeline_safety", MODULE)
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


class PipelineSafetyTests(unittest.TestCase):
    def test_forge_preserves_virtualenv_interpreter_path(self):
        with tempfile.TemporaryDirectory() as root:
            interpreter = Path(root) / "venv/bin/python"
            interpreter.parent.mkdir(parents=True)
            interpreter.symlink_to(sys.executable)
            with mock.patch.object(P.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "3.12\n", "")):
                self.assertEqual(P.ensure_forge_python({"forge_python_path": str(interpreter)}), str(interpreter))

    def test_shared_deadline_includes_extraction(self):
        config = {"_job_deadline": time.time() + 3}
        self.assertLessEqual(P.bounded_timeout(config, 1800), 3)
        config["_job_deadline"] = time.time() - 1
        with self.assertRaisesRegex(RuntimeError, "deadline"):
            P.bounded_timeout(config, 180)

    def test_timeout_stops_descendants_and_retains_output(self):
        with tempfile.TemporaryDirectory() as root:
            marker = Path(root) / "descendant-finished"
            child = f"import time; from pathlib import Path; time.sleep(2); Path({str(marker)!r}).touch()"
            code = f"import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{child!r}]); print('started',flush=True); time.sleep(10)"
            with self.assertRaises(subprocess.TimeoutExpired) as caught:
                P.run_process([sys.executable, "-c", code], timeout=1)
            self.assertIn("started", caught.exception.stdout)
            time.sleep(1.3)
            self.assertFalse(marker.exists())

    def test_lock_rejects_second_writer_and_releases(self):
        with tempfile.TemporaryDirectory() as root:
            config = {"vault": Path(root), "local_state_dir": Path(root) / "local"}
            with P.pipeline_lock(config):
                with self.assertRaisesRegex(RuntimeError, "already running"):
                    with P.pipeline_lock(config):
                        pass
            with P.pipeline_lock(config):
                pass
            self.assertFalse((Path(root) / "system/runtime/knowledge-pipeline.lock").exists())

    def test_preserves_human_sections_and_is_idempotent(self):
        original = "# Paper\nOld prose\n\n## 人工复核\n- [x] Checked by human\n\n<!-- user-notes:start -->\nMy observation\n<!-- user-notes:end -->\n\n<!-- intensive-reading:U01:start -->\nVerified correction\n<!-- intensive-reading:U01:end -->\n\n# 提问\n## 1\nQ：why\nA：because\n"
        candidate = "# Paper\nNew prose\n\n## 人工复核\n- [ ] New ambiguity\n\n# 提问\nInvented dialog\n"
        merged = P.preserve_human_content(original, candidate)
        for phrase in ("My observation", "Verified correction", "Q：why", "A：because", "- [x] Checked by human", "- [ ] New ambiguity"):
            self.assertIn(phrase, merged)
        self.assertNotIn("Invented dialog", merged)
        self.assertEqual(merged, P.preserve_human_content(original, merged))

    def test_candidate_keeps_new_review_when_old_note_has_only_chat(self):
        result = P.preserve_human_content("# Paper\n# 提问\nQ：old\n", "# Paper\n## 人工复核\nReview prose\n- [ ] New check\n<!-- user-notes:start -->\n<!-- user-notes:end -->\n")
        self.assertIn("Review prose", result)
        self.assertIn("<!-- user-notes:start -->", result)
        self.assertIn("Q：old", result)

    def test_publication_detects_edit_and_keeps_original_images(self):
        with tempfile.TemporaryDirectory() as root:
            vault = Path(root)
            config = {"vault": vault}
            task = {"id": "paper:TEST:hash", "sha256": "hash", **P.paper_note_identity({"title": "Example", "creators": ["A"]}, "2026-09-05")}
            note = vault / task["note_path"]
            note.parent.mkdir(parents=True)
            note.write_text("# original")
            image = vault / task["images_dir"] / "fig.png"
            image.parent.mkdir(parents=True)
            image.write_bytes(b"old-image")
            P.prepare_forge_runtime(config, task, 1800)
            staged, baseline = P.candidate_workspace(config, task)
            (staged["vault"] / task["note_path"]).write_text(f"# new\n![[{task['images_dir']}/fig.png]]")
            (staged["vault"] / task["images_dir"] / "fig.png").write_bytes(b"new-image")
            note.write_text("Concurrent human edit")
            with self.assertRaisesRegex(RuntimeError, "edit_conflict"):
                P.publish_candidate(config, staged, task, baseline)
            self.assertEqual(note.read_text(), "Concurrent human edit")
            self.assertEqual(image.read_bytes(), b"old-image")
            note.write_bytes(baseline)
            P.publish_candidate(config, staged, task, baseline)
            self.assertEqual(image.read_bytes(), b"old-image")
            self.assertIn("fig-", note.read_text())

    def test_review_hash_excludes_review_metadata_but_not_body(self):
        original = "---\ntype: paper\nstatus: draft\nreviewed: false\n---\n# Paper\n## 人工复核\n- [x] Checked\n"
        digest = P.review_content_hash(original)
        reviewed = original.replace("status: draft", "status: reviewed").replace("reviewed: false", f"reviewed: true\nreviewed_content_sha256: {digest}\nreview_warnings_accepted: true")
        P.validate_review_gate(reviewed)
        with self.assertRaisesRegex(RuntimeError, "stale"):
            P.validate_review_gate(reviewed + "Changed body\n")

    def test_restore_recovers_drafted_state_not_pending(self):
        with tempfile.TemporaryDirectory() as root:
            vault = Path(root)
            note = vault / "wiki/papers/2026-09-05 - A - Paper.md"
            note.parent.mkdir(parents=True)
            note.write_text('---\ntype: paper\nstatus: draft\nsource_id: "paper:TEST:hash"\nsource_sha256: hash\n---\n# note\n')
            candidate = {"id": "paper:TEST:hash", "sha256": "hash", "source_path": "sources/test.pdf"}
            self.assertTrue(P.recover_existing_note(vault, candidate))
            self.assertEqual(candidate["status"], "drafted")
            self.assertEqual(candidate["note_path"], str(note.relative_to(vault)))

    def test_stable_identity_ignores_attachment_versions(self):
        self.assertEqual(P.stable_paper_identity({"doi": "https://doi.org/10.1234/ABC", "attachment_key": "ONE"}), P.stable_paper_identity({"doi": "10.1234/abc", "attachment_key": "TWO"}))

    def test_quota_is_not_a_generic_timeout(self):
        self.assertEqual(P.classify_failure("Your workspace is out of credits."), "quota_exhausted")

    def test_complete_ingest_is_staged_and_style_only_does_not_repair(self):
        with tempfile.TemporaryDirectory() as root:
            vault = Path(root)
            config = {"vault": vault, "forge_python_path": sys.executable, "local_state_dir": vault / "local"}
            source = vault / "sources/literature/pdf/source.pdf"
            source.parent.mkdir(parents=True)
            source.write_bytes(b"PDF fixture")
            task = P.paper_task({"destination": str(source.relative_to(vault)), "attachment_key": "TEST", "parent_key": "PARENT", "title": "Example", "creators": ["A"]}, vault)
            task.update(P.paper_note_identity(task, "2026-09-05"))
            task["generated_date"] = "2026-09-05"
            task["redraft_requested_at"] = "2026-09-05T12:00:00+00:00"
            note = vault / task["note_path"]
            note.parent.mkdir(parents=True)
            original = "---\ntype: paper\nstatus: draft\nreviewed: false\n---\n# Original\n## 人工复核\n- [x] Old check\n# 提问\nQ：human question\nA：saved answer\n"
            note.write_text(original)
            (vault / "wiki/index.md").write_text("# Index\n## 待审核草稿\n")
            extract = vault / task["extract_path"]
            extract.parent.mkdir(parents=True)
            extract.write_text("# Full source fixture")
            P.save_queue(config, {"items": [task]})
            def fake_generation(staged, live, current, prompt):
                self.assertNotEqual(staged["vault"], vault)
                self.assertEqual(note.read_text(), original)
                self.assertIn("_job_deadline", staged)
                candidate = staged["vault"] / current["note_path"]
                candidate.parent.mkdir(parents=True, exist_ok=True)
                candidate.write_text("---\ntype: paper\nstatus: draft\ngeneration_stage: ready_for_validation\nimpact_factor: null\nimpact_factor_year: null\nimpact_factor_source: null\nimpact_factor_retrieved_at: null\n" + f"images_dir: {current['images_dir']}\n---\n# {current['display_title']}\nNew body\n## 人工复核\n- [ ] New issue\n")
                return subprocess.CompletedProcess([], 0, "saved", "")
            with mock.patch.object(P, "ensure_paper_skills", return_value=["forge-paper-note"]), mock.patch.object(P, "ensure_forge_python", return_value=sys.executable), mock.patch.object(P, "extract_pdf", return_value=extract), mock.patch.object(P, "generate_forge", side_effect=fake_generation), mock.patch.object(P, "validate_forge_draft", return_value={"passed": False, "warnings": ["note:style"], "blocking_issues": []}), mock.patch.object(P, "codex_command") as repair:
                self.assertEqual(P.ingest_next(config), 0)
            repair.assert_not_called()
            self.assertIn("New body", note.read_text())
            self.assertIn("Q：human question", note.read_text())
            self.assertIn("- [ ] New issue", note.read_text())
            current = P.load_queue(config)["items"][0]
            self.assertEqual(current["status"], "drafted")
            self.assertEqual(current["forge_validation_status"], "draft_with_warnings")

    def test_resume_plan_skips_full_analysis(self):
        with tempfile.TemporaryDirectory() as root:
            vault = Path(root)
            config = {"vault": vault}
            task = {"id": "paper:ONE:hash", "sha256": "hash", "note_path": "note.md", "forge_generation_budget_seconds": 30, "forge_note_plan_path": "plan.json", "forge_resume_plan_path": "previous.json"}
            (vault / "previous.json").write_text(json.dumps({key: {"exists": True} for key in ("prior_work_matrix", "question_answer_map", "followup", "terminology_ledger")}))
            with mock.patch.object(P, "codex_command", return_value=subprocess.CompletedProcess([], 0, "", "")) as codex:
                P.generate_forge(config, config, task, "task prompt")
            self.assertEqual(codex.call_count, 1)
            self.assertIn("PHASE_OVERRIDE: draft", codex.call_args.args[1])


if __name__ == "__main__":
    unittest.main()

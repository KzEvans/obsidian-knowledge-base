"""Offline regression tests: no model calls, real source files, or live queue writes."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

MODULE = Path(__file__).resolve().parents[1] / "knowledge-base/system/knowledge/run_pipeline.py"
spec = importlib.util.spec_from_file_location("pipeline_cost_guards", MODULE)
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


class CostGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.vault = Path(self.temp.name)
        self.config = {"vault": self.vault, "local_state_dir": self.vault / "local"}
        self.task = {
            "id": "paper:ONE:hash", "kind": "paper", "status": "pending",
            "sha256": "hash", "source_path": "sources/test.pdf",
            **P.paper_note_identity({"title": "Paper", "creators": ["A"]}, "2026-09-23"),
        }

    def existing_note(self):
        note = self.vault / self.task["note_path"]
        note.parent.mkdir(parents=True, exist_ok=True)
        note.write_text('---\ntype: paper\nstatus: reviewed\nsource_id: "paper:ONE:hash"\nsource_sha256: hash\n---\n# Paper\nHuman annotation\n')
        return note

    def test_rolled_back_queue_is_reconciled_before_model_or_extraction(self):
        note = self.existing_note()
        before = note.read_bytes()
        P.save_queue(self.config, {"items": [self.task]})
        with mock.patch.object(P, "codex_command") as model, mock.patch.object(P, "extract_pdf") as extract:
            for _ in range(3):
                self.assertEqual(P.ingest_next(self.config), 0)
        model.assert_not_called()
        extract.assert_not_called()
        self.assertEqual(P.load_queue(self.config)["items"][0]["status"], "reviewed")
        self.assertEqual(note.read_bytes(), before)

    def test_completed_receipt_blocks_regeneration_after_note_disappears(self):
        self.existing_note()
        P.record_admission(self.config, self.task)
        (self.vault / self.task["note_path"]).unlink()
        self.assertTrue(P.reconcile_before_generation(self.config, self.task))
        self.assertEqual(self.task["status"], "needs_reconciliation")

    def test_consumed_or_older_redraft_request_cannot_repeat(self):
        self.existing_note()
        self.task["redraft_requested_at"] = "2026-01-01T00:00:00+00:00"
        P.record_admission(self.config, self.task)
        self.assertTrue(P.reconcile_before_generation(self.config, self.task))
        self.task.update(status="pending", redraft_requested_at="2025-12-01T00:00:00+00:00")
        self.assertTrue(P.reconcile_before_generation(self.config, self.task))
        self.task.update(status="pending", redraft_requested_at="2999-01-01T00:00:00+00:00")
        self.assertFalse(P.reconcile_before_generation(self.config, self.task))

    def test_existing_unidentified_note_requires_reconciliation(self):
        note = self.existing_note()
        note.write_text("# Human-authored note without generation identity")
        self.assertTrue(P.reconcile_before_generation(self.config, self.task))
        self.assertEqual(self.task["status"], "needs_reconciliation")

    def test_failed_tasks_are_not_automatically_retried(self):
        self.task["status"] = "failed"
        P.save_queue(self.config, {"items": [self.task]})
        with mock.patch.object(P, "codex_command") as model:
            self.assertEqual(P.ingest_next(self.config), 0)
        model.assert_not_called()

    def test_resume_reuses_partial_note_and_images(self):
        P.prepare_forge_runtime(self.config, self.task, 1800)
        staged, _ = P.candidate_workspace(self.config, self.task)
        partial = staged["vault"] / self.task["note_path"]
        partial.parent.mkdir(parents=True, exist_ok=True)
        partial.write_text("---\ngeneration_stage: writing\n---\n# Paper\nCompleted first section")
        asset = staged["vault"] / self.task["images_dir"] / "fig.png"
        asset.parent.mkdir(parents=True)
        asset.write_bytes(b"source crop")
        P.atomic_write_json(staged["vault"] / self.task["forge_note_plan_path"], {"claim": "saved"})
        P.collect_candidate_reports(self.config, staged, self.task)
        P.prepare_forge_runtime(self.config, self.task, 1800)
        resumed, _ = P.candidate_workspace(self.config, self.task)
        self.assertEqual((resumed["vault"] / self.task["note_path"]).read_bytes(), partial.read_bytes())
        self.assertEqual((resumed["vault"] / self.task["images_dir"] / "fig.png").read_bytes(), b"source crop")
        self.assertTrue(self.task["forge_resumed_candidate"])

    def test_resume_does_not_restore_stale_candidate_over_human_edits(self):
        note = self.existing_note()
        P.prepare_forge_runtime(self.config, self.task, 1800)
        staged, _ = P.candidate_workspace(self.config, self.task)
        (staged["vault"] / self.task["note_path"]).write_text("stale candidate")
        P.atomic_write_json(staged["vault"] / self.task["forge_note_plan_path"], {"claim": "saved"})
        P.collect_candidate_reports(self.config, staged, self.task)
        note.write_text("New human edit")
        P.prepare_forge_runtime(self.config, self.task, 1800)
        resumed, _ = P.candidate_workspace(self.config, self.task)
        self.assertEqual((resumed["vault"] / self.task["note_path"]).read_text(), "New human edit")
        self.assertFalse(self.task["forge_resumed_candidate"])

    def test_completed_candidate_goes_directly_to_validation(self):
        P.prepare_forge_runtime(self.config, self.task, 1800)
        plan = {key: ["saved"] for key in ("prior_work_matrix", "question_answer_map", "followup", "terminology_ledger")}
        P.atomic_write_json(self.vault / self.task["forge_note_plan_path"], plan)
        note = self.existing_note()
        note.write_text("---\ngeneration_stage: ready_for_validation\n---\n# Complete candidate")
        self.task["forge_resumed_candidate"] = True
        with mock.patch.object(P, "codex_command") as model:
            result = P.generate_forge(self.config, self.config, self.task, "resume")
        self.assertEqual(result.returncode, 0)
        model.assert_not_called()

    def test_wall_time_expiry_includes_sleep_jump(self):
        with mock.patch.object(P.time, "time", side_effect=[100.0, 200.0]):
            with self.assertRaises(subprocess.TimeoutExpired) as caught:
                P.run_process([sys.executable, "-c", "import time; time.sleep(10)"], timeout=30)
        self.assertEqual(caught.exception.stop_reason, "wall_deadline_exceeded")

    def test_console_output_does_not_reset_artifact_watchdog(self):
        with self.assertRaises(subprocess.TimeoutExpired) as caught:
            P.run_process([sys.executable, "-u", "-c", "import time\nwhile True:\n print('working'); time.sleep(.02)"],
                          timeout=5, progress_paths=[self.vault / "absent.md"], progress_timeout=0.15)
        self.assertEqual(caught.exception.stop_reason, "artifact_stalled")
        self.assertIn("working", caught.exception.stdout)

    def test_budget_configuration_and_usage_are_shared_between_phases(self):
        config = {**self.config, "codex_path": "codex", "_forge_usage": {"tokens": 0}, "forge_token_budget": 100000}
        event = json.dumps({"type": "turn.completed", "usage": {"input_tokens": 9000, "cached_input_tokens": 8000, "output_tokens": 1000}})
        with mock.patch.object(P, "run_process", return_value=subprocess.CompletedProcess([], 0, event, "")) as run:
            P.codex_command(config, "plan", "last-plan-ONE")
            self.assertIn("features.rollout_budget.limit_tokens=35000", run.call_args.args[0])
            self.assertEqual(run.call_args.kwargs["max_reconnections"], 1)
            self.assertIn("--json", run.call_args.args[0])
            P.codex_command(config, "draft", "last-ingest-ONE")
            self.assertIn("features.rollout_budget.limit_tokens=65000", run.call_args.args[0])
            with self.assertRaisesRegex(RuntimeError, "token_budget_exceeded"):
                P.codex_command(config, "unexpected repeat", "last-ingest-ONE")
        self.assertEqual(config["_forge_usage"]["tokens"], 20000)

    def test_reconnect_limit_stops_even_with_artifact_activity(self):
        with self.assertRaises(subprocess.TimeoutExpired) as caught:
            P.run_process([sys.executable, "-u", "-c", "import time; print('Reconnecting 2/5...'); time.sleep(10)"],
                          timeout=5, max_reconnections=1, progress_paths=[self.vault / "absent"], progress_timeout=0.15)
        self.assertEqual(caught.exception.stop_reason, "connection_retry_limit")

    def test_disabled_token_budget_keeps_usage_and_other_guards_without_caps(self):
        config = {**self.config, "codex_path": "codex", "forge_token_budget": None,
                  "forge_plan_token_budget": None, "forge_draft_token_budget": None,
                  "forge_repair_token_budget": None,
                  "_forge_usage": {"tokens": 1000000, "reserved_tokens": 1000000}}
        event = json.dumps({"type": "turn.completed", "usage": {"input_tokens": 9000, "output_tokens": 1000}})
        with mock.patch.object(P, "run_process", return_value=subprocess.CompletedProcess([], 0, event, "")) as run:
            for phase in ("plan", "ingest", "repair"):
                P.codex_command(config, "continue", f"last-{phase}-ONE")
                command = run.call_args.args[0]
                self.assertIn("features.rollout_budget.enabled=false", command)
                self.assertFalse(any("rollout_budget.limit_tokens=" in arg for arg in command))
                self.assertEqual(run.call_args.kwargs["max_reconnections"], 1)
                self.assertEqual(run.call_args.kwargs["progress_timeout"], 600)
                self.assertIn("features.multi_agent=false", command)
                self.assertIn("features.unbounded_connection_retries=false", command)
        self.assertEqual(config["_forge_usage"]["tokens"], 1030000)
        self.assertTrue(P.forge_tokens_available(config))

    def test_forge_reasoning_override_applies_to_each_forge_phase(self):
        config = {**self.config, "codex_path": "codex", "forge_token_budget": None,
                  "forge_reasoning_effort": "xhigh", "_forge_usage": {"tokens": 0}}
        with mock.patch.object(P, "run_process", return_value=subprocess.CompletedProcess([], 0, "", "")) as run:
            for phase in ("plan", "ingest", "repair"):
                P.codex_command(config, "task", f"last-{phase}-ONE")
                command = run.call_args.args[0]
                setting = command.index("model_reasoning_effort=xhigh")
                self.assertEqual(command[setting - 1], "-c")
                self.assertEqual(command.count("model_reasoning_effort=xhigh"), 1)
                self.assertNotIn("--model", command)

    def test_unconfigured_reasoning_and_other_workflows_keep_inheritance(self):
        for config in (
            {"_forge_usage": {"tokens": 0}},
            {"_forge_usage": {"tokens": 0}, "forge_reasoning_effort": None},
            {"_forge_usage": {"tokens": 0}, "forge_reasoning_effort": ""},
            {"forge_reasoning_effort": "xhigh"},
        ):
            with self.subTest(config=config):
                current = {**self.config, "codex_path": "codex", "forge_token_budget": None, **config}
                with mock.patch.object(P, "run_process", return_value=subprocess.CompletedProcess([], 0, "", "")) as run:
                    P.codex_command(current, "task", "last-ingest-ONE")
                self.assertFalse(any(arg.startswith("model_reasoning_effort=") for arg in run.call_args.args[0]))

    def run_fake_ingest(self, complete, validation):
        source = self.vault / self.task["source_path"]
        source.parent.mkdir(parents=True)
        source.write_bytes(b"immutable PDF fixture")
        self.task.update(sha256=P.file_sha256(source), generated_date="2026-09-23", extract_path="extracts/test.md")
        index = self.vault / "wiki/index.md"
        index.parent.mkdir(parents=True)
        index.write_text("# Index\n## 待审核草稿\n")
        P.save_queue(self.config, {"items": [self.task]})
        def generate(staged, live, task, prompt):
            note = staged["vault"] / task["note_path"]
            note.parent.mkdir(parents=True, exist_ok=True)
            stage = "ready_for_validation" if complete else "writing"
            note.write_text(f"---\ntype: paper\nstatus: draft\ngeneration_stage: {stage}\nimpact_factor: null\nimpact_factor_year: null\nimpact_factor_source: null\nimpact_factor_retrieved_at: null\nimages_dir: {task['images_dir']}\n---\n# {task['display_title']}\nSaved prose\n## 人工复核\n- [ ] Check evidence\n")
            return subprocess.CompletedProcess([], 0 if complete else 1, "", "connection interrupted")
        with mock.patch.object(P, "ensure_paper_skills", return_value=["forge-paper-note"]), mock.patch.object(P, "ensure_forge_python", return_value=sys.executable), mock.patch.object(P, "extract_pdf", return_value=self.vault / self.task["extract_path"]), mock.patch.object(P, "generate_forge", side_effect=generate), mock.patch.object(P, "validate_forge_draft", return_value=validation), mock.patch.object(P, "codex_command") as model:
            result = P.ingest_next(self.config)
        model.assert_not_called()
        self.assertEqual(source.read_bytes(), b"immutable PDF fixture")
        return result, P.load_queue(self.config)["items"][0]

    def test_blocking_lint_does_not_start_automatic_model_repair(self):
        result, task = self.run_fake_ingest(True, {"passed": False, "warnings": ["technical:example"], "blocking_issues": ["technical:example"]})
        self.assertEqual(result, 0)
        self.assertEqual(task["forge_validation_status"], "draft_with_warnings")
        self.assertTrue((self.vault / task["note_path"]).is_file())

    def test_interrupted_partial_is_retained_but_not_published(self):
        result, task = self.run_fake_ingest(False, {})
        self.assertEqual(result, 1)
        self.assertEqual(task["status"], "failed")
        self.assertIn("partial_draft_retained", task["last_error"])
        self.assertFalse((self.vault / task["note_path"]).exists())
        self.assertIn("Saved prose", (self.vault / task["forge_candidate_path"]).read_text())


if __name__ == "__main__":
    unittest.main()

"""Offline phase-resume tests for partial Forge planning checkpoints."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


MODULE = Path(__file__).resolve().parents[1] / "knowledge-base/system/knowledge/run_pipeline.py"
spec = importlib.util.spec_from_file_location("forge_planning_checkpoints", MODULE)
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


class PlanningCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.vault = Path(self.temp.name)
        self.config = {"vault": self.vault, "forge_token_budget": None}
        self.task = {
            "id": "paper:ONE:hash", "sha256": "hash",
            "note_path": "wiki/papers/Paper.md", "images_dir": "wiki/papers/images/Paper",
            "forge_note_plan_path": "runtime/plan.json",
            "forge_generation_budget_seconds": 30,
        }
        self.plan = {key: ["saved evidence"] for key in (
            "prior_work_matrix", "question_answer_map", "followup", "terminology_ledger")}

    def save_plan(self, stage=None, previous=False):
        plan = dict(self.plan)
        if stage is not None:
            plan["generation_stage"] = stage
        relative = "runtime/previous.json" if previous else self.task["forge_note_plan_path"]
        if previous:
            self.task["forge_resume_plan_path"] = relative
        P.atomic_write_json(self.vault / relative, plan)
        return plan

    def model_finishes_plan(self, config, prompt, log_prefix, **kwargs):
        if "PHASE_OVERRIDE: plan" in prompt:
            self.assertIn("generation_stage: planning", prompt)
            self.assertIn("ready_for_drafting", prompt)
            self.assertIn("全文分析前", prompt)
            self.assertIn("Base64", prompt)
            self.assertIn("不要阅读 lint 脚本的实现", prompt)
            self.assertIn("每份必需规则/参考只读取一次", prompt)
            self.assertIn("本地图片查看工具", prompt)
            self.save_plan("ready_for_drafting")
        return subprocess.CompletedProcess([], 0, "saved", "")

    def test_partial_previous_plan_resumes_analysis_once_before_drafting(self):
        partial = self.save_plan("planning", previous=True)
        calls = []
        def model(config, prompt, log_prefix, **kwargs):
            calls.append(prompt)
            if "PHASE_OVERRIDE: plan" in prompt:
                self.assertEqual(P.read_json(self.vault / self.task["forge_note_plan_path"], None), partial)
            return self.model_finishes_plan(config, prompt, log_prefix, **kwargs)
        with mock.patch.object(P, "codex_command", side_effect=model):
            result = P.generate_forge(self.config, self.config, self.task, "task")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(calls), 2)
        self.assertIn("PHASE_OVERRIDE: plan", calls[0])
        self.assertIn("PHASE_OVERRIDE: draft", calls[1])

    def test_complete_plan_uses_only_draft_phase(self):
        self.save_plan("ready_for_drafting", previous=True)
        with mock.patch.object(P, "codex_command", return_value=subprocess.CompletedProcess([], 0, "", "")) as model:
            P.generate_forge(self.config, self.config, self.task, "task")
        self.assertEqual(model.call_count, 1)
        self.assertIn("PHASE_OVERRIDE: draft", model.call_args.args[1])
        self.assertIn("立即将 generation_stage 改为 ready_for_validation", model.call_args.args[1])
        self.assertIn("然后才处理可选配图", model.call_args.args[1])
        self.assertEqual(self.config["_artifact_paths"], [self.vault / self.task["note_path"], self.vault / self.task["images_dir"]])

    def test_plan_gets_sixty_percent_without_consuming_the_draft_reserve(self):
        self.task["forge_generation_budget_seconds"] = 1500
        with mock.patch.object(P, "codex_command", side_effect=self.model_finishes_plan) as model:
            P.generate_forge(self.config, self.config, self.task, "task")
        budget = model.call_args_list[0].kwargs["timeout_seconds"]
        self.assertGreaterEqual(budget, 890)
        self.assertLessEqual(budget, 900)
        self.assertIn("不重新逐页读取全文", model.call_args_list[0].args[1])

    def test_partial_plan_cannot_skip_to_repair_only_validation(self):
        self.save_plan("planning")
        self.task["forge_repair_only"] = True
        with mock.patch.object(P, "codex_command") as model:
            with self.assertRaisesRegex(RuntimeError, "repair_requires_plan"):
                P.generate_forge(self.config, self.config, self.task, "repair")
        model.assert_not_called()

    def test_paused_automatic_selection_still_allows_explicit_note(self):
        task = dict(self.task, status="pending")
        P.save_queue(self.config, {"items": [task]})
        paused = dict(self.config, ingest_paused=True)
        with mock.patch.object(P, "reconcile_before_generation", return_value=True) as reconcile:
            self.assertEqual(P.ingest_next(paused), 0)
            reconcile.assert_not_called()
            self.assertEqual(P.ingest_next(paused, task["note_path"]), 0)
            self.assertEqual(reconcile.call_args.args[1]["id"], task["id"])

    def test_pinned_forge_model_is_a_per_command_argument(self):
        config = dict(self.config, codex_path="codex", forge_model="gpt-6.1-sol", _forge_usage={"tokens": 0})
        with mock.patch.object(P, "run_process", return_value=subprocess.CompletedProcess([], 0, "", "")) as run:
            P.codex_command(config, "draft", "last-ingest-ONE")
        command = run.call_args.args[0]
        self.assertEqual(command[command.index("--model")+1], "gpt-6.1-sol")
        self.assertIn("features.rollout_budget.enabled=false", command)

    def test_explicit_paper_deadline_preserves_defaults_and_nonpaper_limit(self):
        self.assertEqual(P.ingest_timeout_seconds({}, {"kind": "paper"}), 1800)
        self.assertEqual(P.ingest_timeout_seconds({"forge_job_timeout_seconds": 3600}, {"kind": "paper"}), 3600)
        self.assertEqual(P.ingest_timeout_seconds({"forge_job_timeout_seconds": 3600}, {"kind": "experiment"}), 1800)

    def test_explicit_longer_paper_deadline_is_in_the_model_prompt(self):
        config = dict(self.config, codex_path="codex", forge_job_timeout_seconds=3600, _forge_usage={"tokens": 0})
        with mock.patch.object(P, "run_process", return_value=subprocess.CompletedProcess([], 0, "", "")) as run:
            P.codex_command(config, "draft", "last-ingest-ONE")
        self.assertIn("3600 秒", run.call_args.args[0][-1])
        self.assertEqual(run.call_args.kwargs["progress_timeout"], 600)

    def test_legacy_complete_plan_keeps_draft_only_compatibility(self):
        self.save_plan(previous=True)
        with mock.patch.object(P, "codex_command", return_value=subprocess.CompletedProcess([], 0, "", "")) as model:
            P.generate_forge(self.config, self.config, self.task, "task")
        self.assertEqual(model.call_count, 1)
        self.assertIn("PHASE_OVERRIDE: draft", model.call_args.args[1])

    def test_successful_but_still_partial_plan_cannot_start_drafting(self):
        self.save_plan("planning")
        with mock.patch.object(P, "codex_command", return_value=subprocess.CompletedProcess([], 0, "", "")) as model:
            with self.assertRaisesRegex(RuntimeError, "planning_incomplete"):
                P.generate_forge(self.config, self.config, self.task, "task")
        self.assertEqual(model.call_count, 1)
        self.assertIn("PHASE_OVERRIDE: plan", model.call_args.args[1])

    def test_interrupted_planning_keeps_partial_plan_without_draft_call(self):
        self.save_plan("planning")
        result = subprocess.CompletedProcess([], 1, "partial checkpoint saved", "interrupted")
        with mock.patch.object(P, "codex_command", return_value=result) as model:
            self.assertIs(P.generate_forge(self.config, self.config, self.task, "task"), result)
        self.assertEqual(model.call_count, 1)
        self.assertEqual(P.read_json(self.vault / self.task["forge_note_plan_path"], None)["generation_stage"], "planning")

    def test_incomplete_plan_does_not_admit_candidate_as_validation_ready(self):
        self.save_plan("planning")
        self.task["forge_resumed_candidate"] = True
        note = self.vault / self.task["note_path"]
        note.parent.mkdir(parents=True)
        note.write_text("---\ngeneration_stage: ready_for_validation\n---\n# Candidate")
        with mock.patch.object(P, "codex_command", side_effect=self.model_finishes_plan) as model:
            P.generate_forge(self.config, self.config, self.task, "task")
        self.assertEqual(model.call_count, 2)
        self.assertIn("PHASE_OVERRIDE: plan", model.call_args_list[0].args[1])

    def test_complete_candidate_and_plan_need_no_model_phase(self):
        self.save_plan("ready_for_drafting")
        self.task["forge_resumed_candidate"] = True
        note = self.vault / self.task["note_path"]
        note.parent.mkdir(parents=True)
        note.write_text("---\ngeneration_stage: ready_for_validation\n---\n# Candidate")
        with mock.patch.object(P, "codex_command") as model:
            result = P.generate_forge(self.config, self.config, self.task, "task")
        self.assertEqual(result.returncode, 0)
        model.assert_not_called()

    def test_runtime_reuses_partial_plan_and_candidate_with_same_source(self):
        first = P.prepare_forge_runtime(self.config, self.task, 1800)
        staged, _ = P.candidate_workspace(self.config, self.task)
        partial = {"source_sha256": "hash", "generation_stage": "planning", "central_claim": "saved"}
        P.atomic_write_json(staged["vault"] / self.task["forge_note_plan_path"], partial)
        candidate = staged["vault"] / self.task["note_path"]
        candidate.parent.mkdir(parents=True)
        candidate.write_text("---\ngeneration_stage: writing\n---\n# Saved candidate")
        P.collect_candidate_reports(self.config, staged, self.task)
        P.prepare_forge_runtime(self.config, self.task, 1800)
        resumed, _ = P.candidate_workspace(self.config, self.task)
        self.assertEqual(self.task["forge_resume_plan_path"], first["forge_note_plan_path"])
        self.assertTrue(self.task["forge_resumed_candidate"])
        self.assertEqual((resumed["vault"] / self.task["note_path"]).read_text(), candidate.read_text())
        phases = []
        def model(config, prompt, log_prefix, **kwargs):
            phases.append(prompt)
            if "PHASE_OVERRIDE: plan" in prompt:
                path = config["vault"] / self.task["forge_note_plan_path"]
                self.assertEqual(P.read_json(path, None), partial)
                P.atomic_write_json(path, {**self.plan, "generation_stage": "ready_for_drafting"})
            return subprocess.CompletedProcess([], 0, "", "")
        with mock.patch.object(P, "codex_command", side_effect=model):
            P.generate_forge(resumed, self.config, self.task, "task")
        self.assertEqual(len(phases), 2)
        self.assertIn("PHASE_OVERRIDE: plan", phases[0])
        self.assertIn("PHASE_OVERRIDE: draft", phases[1])


if __name__ == "__main__":
    unittest.main()

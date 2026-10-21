"""Offline checks for the actual stop reason, folder priority, and PDF metadata correction."""
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

MODULE = Path(__file__).resolve().parents[1] / "knowledge-base/system/knowledge/run_pipeline.py"
spec = importlib.util.spec_from_file_location("forge_reporting", MODULE)
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


class ForgeReportingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.vault = Path(self.tmp.name)
        self.config = {"vault": self.vault, "local_state_dir": self.vault / "local"}
        self.task = {"id": "paper:TEST:hash", "kind": "paper", "status": "pending",
                     "source_path": "sources/test.pdf", "extract_path": "extracts/test.md",
                     "sha256": "hash", "generated_date": "2026-10-12",
                     **P.paper_note_identity({"title": "Paper", "creators": ["A"]}, "2026-10-12")}

    def json_failure(self, message, include_turn=True):
        events = [
            {"type": "item.completed", "item": {"type": "error", "message": "Unrecognized transport setting ignored"}},
            {"type": "error", "message": message},
        ]
        if include_turn:
            events.append({"type": "turn.failed", "error": {"message": message}})
        return subprocess.CompletedProcess([], 1, "\n".join(json.dumps(event) for event in events), "Reading additional input from stdin...\n")

    def test_terminal_turn_error_takes_priority_over_warning_and_top_level_error(self):
        for message, kind in [
            ("Selected model is at capacity. Please try a different model.", "model_at_capacity"),
            ("insufficient_quota: out of credits", "quota_exhausted"),
            ("invalid_api_key: unauthorized", "authentication"),
        ]:
            with self.subTest(kind=kind):
                result = self.json_failure("Connection warning")
                events = result.stdout.splitlines()
                events[-1] = json.dumps({"type": "turn.failed", "error": {"message": message}})
                result.stdout = "\n".join(events)
                self.assertEqual(P.codex_failure_detail(result), message)
                self.assertEqual(P.classify_failure(P.codex_failure_detail(result)), kind)

    def test_top_level_fatal_error_is_used_without_turn_failed(self):
        message = "Selected model is at capacity. Please try a different model."
        self.assertEqual(P.codex_failure_detail(self.json_failure(message, include_turn=False)), message)

    def test_nonfatal_item_warning_is_not_promoted_to_task_error(self):
        stdout = json.dumps({"type": "item.completed", "item": {"type": "error", "message": "Ignored transport configuration warning"}})
        result = subprocess.CompletedProcess([], 1, stdout, "Reading additional input from stdin...\n")
        self.assertEqual(P.codex_failure_detail(result), "Codex ingest failed (exit code 1)")
        result.stderr += "Real command error\n"
        self.assertEqual(P.codex_failure_detail(result), "Real command error")
        self.assertEqual(P.codex_failure_detail(subprocess.CompletedProcess([], 1, "plain failure", "")), "plain failure")

    def test_ingest_records_actual_model_capacity_failure(self):
        source = self.vault / self.task["source_path"]
        source.parent.mkdir(parents=True)
        source.write_bytes(b"fixture PDF")
        task = {**self.task, "sha256": P.file_sha256(source)}
        P.save_queue(self.config, {"items": [task]})
        message = "Selected model is at capacity. Please try a different model."
        with mock.patch.object(P, "ensure_paper_skills", return_value=["forge-paper-note"]), mock.patch.object(P, "ensure_forge_python", return_value=sys.executable), mock.patch.object(P, "extract_pdf", return_value=self.vault / task["extract_path"]), mock.patch.object(P, "generate_forge", return_value=self.json_failure(message)):
            self.assertEqual(P.ingest_next(self.config), 1)
        saved = P.load_queue(self.config)["items"][0]
        self.assertEqual(saved["failure_kind"], "model_at_capacity")
        self.assertEqual(saved["last_error"], message)
        self.assertFalse((self.vault / task["note_path"]).exists())

    def run_saved_candidate_with_capacity_failure(self, generation_stage):
        source = self.vault / self.task["source_path"]
        source.parent.mkdir(parents=True)
        source.write_bytes(b"fixture PDF")
        task = {**self.task, "sha256": P.file_sha256(source)}
        P.save_queue(self.config, {"items": [task]})
        message = "Selected model is at capacity. Please try a different model."
        def generation(staged, live, current, prompt):
            candidate = staged["vault"] / current["note_path"]
            candidate.parent.mkdir(parents=True, exist_ok=True)
            candidate.write_text(f"---\ntype: paper\nstatus: draft\ngeneration_stage: {generation_stage}\n---\n# {current['display_title']}\nSaved evidence paragraph\n")
            return self.json_failure(message)
        with mock.patch.object(P, "ensure_paper_skills", return_value=["forge-paper-note"]), mock.patch.object(P, "ensure_forge_python", return_value=sys.executable), mock.patch.object(P, "extract_pdf", return_value=self.vault / task["extract_path"]), mock.patch.object(P, "generate_forge", side_effect=generation), mock.patch.object(P, "validate_forge_draft") as validate, mock.patch.object(P, "publish_candidate") as publish:
            self.assertEqual(P.ingest_next(self.config), 1)
        validate.assert_not_called()
        publish.assert_not_called()
        self.assertEqual(source.read_bytes(), b"fixture PDF")
        saved = P.load_queue(self.config)["items"][0]
        self.assertFalse((self.vault / saved["note_path"]).exists())
        self.assertIn("Saved evidence paragraph", (self.vault / saved["forge_candidate_path"]).read_text())
        return saved, message

    def test_partial_draft_preserves_current_capacity_failure_and_checkpoint(self):
        saved, message = self.run_saved_candidate_with_capacity_failure("writing")
        self.assertEqual(saved["failure_kind"], "model_at_capacity")
        self.assertIn("partial_draft_retained", saved["last_error"])
        self.assertIn(message, saved["last_error"])
        self.assertIn(saved["forge_candidate_path"], saved["last_error"])
        self.assertIn(saved["forge_checkpoint_path"], saved["last_error"])
        self.assertTrue((self.vault / saved["forge_checkpoint_path"]).is_file())

    def test_unrelated_metadata_error_does_not_inherit_capacity_failure(self):
        saved, message = self.run_saved_candidate_with_capacity_failure("ready_for_validation")
        self.assertEqual(saved["failure_kind"], "generation_or_validation")
        self.assertIn("impact_factor", saved["last_error"])
        self.assertNotIn(message, saved["last_error"])

    def test_partial_timeout_preserves_stop_reason_with_502_digits_in_path(self):
        source = self.vault / self.task["source_path"]
        source.parent.mkdir(parents=True)
        source.write_bytes(b"fixture PDF")
        task = {**self.task, "sha256": P.file_sha256(source), "failure_kind": "model_at_capacity"}
        P.save_queue(self.config, {"items": [task]})
        def generation(staged, live, current, prompt):
            candidate = staged["vault"] / current["note_path"]
            candidate.parent.mkdir(parents=True, exist_ok=True)
            candidate.write_text("---\ntype: paper\nstatus: draft\ngeneration_stage: writing\n---\n# Paper\nSaved full text before figures\n")
            error = subprocess.TimeoutExpired(["fake"], 3600, output="optional figure work", stderr="")
            error.stop_reason = "artifact_stalled"
            raise error
        with mock.patch.object(P, "datetime", wraps=datetime) as clock, mock.patch.object(P, "ensure_paper_skills", return_value=["forge-paper-note"]), mock.patch.object(P, "ensure_forge_python", return_value=sys.executable), mock.patch.object(P, "extract_pdf", return_value=self.vault / task["extract_path"]), mock.patch.object(P, "generate_forge", side_effect=generation), mock.patch.object(P, "publish_candidate") as publish:
            clock.now.return_value = datetime(2026, 10, 12, 15, 2, 56, tzinfo=timezone.utc)
            self.assertEqual(P.ingest_next(self.config), 1)
        publish.assert_not_called()
        saved = P.load_queue(self.config)["items"][0]
        self.assertIn("20261012-150256", saved["forge_candidate_path"])
        self.assertEqual(saved["failure_kind"], "artifact_stalled")
        self.assertIn("generation stopped: artifact_stalled", saved["last_error"])
        self.assertIn(saved["forge_checkpoint_path"], saved["last_error"])
        self.assertIn("Saved full text before figures", (self.vault / saved["forge_candidate_path"]).read_text())
        self.assertFalse((self.vault / saved["note_path"]).exists())

    def test_http_statuses_require_status_syntax_not_arbitrary_path_digits(self):
        for message in (
            "partial_draft_retained: system/runtime/forge/paper/20261012-150256-000001/workspace/Paper.md",
            "candidate saved at /papers/401/404/429/502/503.md",
            "saved at /papers/status401/http502/report404.md",
            "sample count 401, step 404, value 429, length 502, width 503",
        ):
            with self.subTest(message=message):
                self.assertEqual(P.classify_failure(message), "generation_or_validation")
        for message, kind in (
            ("HTTP 401", "authentication"), ("HTTP/1.1 401", "authentication"),
            ("HTTP 502", "service_unavailable"), ("HTTP status code: 502", "service_unavailable"),
            ('{"status_code": 503}', "service_unavailable"), ("response status=429", "service_unavailable"),
        ):
            with self.subTest(message=message):
                self.assertEqual(P.classify_failure(message), kind)

    def test_selected_image_file_updates_reset_artifact_watchdog(self):
        image_dir = self.vault / "images"
        nested = image_dir / "selected"
        nested.mkdir(parents=True)
        image = nested / "fig.png"
        image.write_bytes(b"0")
        code = "import pathlib,sys,time\np=pathlib.Path(sys.argv[1])\nfor i in range(8):\n p.write_bytes(str(i).encode()); time.sleep(.06)"
        result = P.run_process([sys.executable, "-c", code, str(image)], timeout=3,
                               progress_paths=[self.vault / "unchanged-note.md", image_dir], progress_timeout=0.18)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(image.read_bytes(), b"7")

    def test_image_reads_directory_touches_and_console_do_not_reset_watchdog(self):
        image_dir = self.vault / "images"
        image_dir.mkdir()
        image = image_dir / "fig.png"
        image.write_bytes(b"saved")
        code = "import os,pathlib,sys,time\np=pathlib.Path(sys.argv[1])\nwhile True:\n p.read_bytes(); os.utime(p.parent,None); (p.parent/'debug.txt').write_text('working'); print('working',flush=True); time.sleep(.02)"
        with self.assertRaises(subprocess.TimeoutExpired) as caught:
            P.run_process([sys.executable, "-u", "-c", code, str(image)], timeout=3,
                          progress_paths=[image_dir], progress_timeout=0.18)
        self.assertEqual(caught.exception.stop_reason, "artifact_stalled")
        self.assertIn("working", caught.exception.stdout)

    def test_reconnection_limit_recognizes_observed_ellipsis_format(self):
        for message in ("Reconnecting... 2/5", "Reconnecting… 2/5"):
            with self.subTest(message=message):
                with self.assertRaises(subprocess.TimeoutExpired) as caught:
                    P.run_process([sys.executable, "-u", "-c", "import sys,time; print(sys.argv[1]); time.sleep(10)", message],
                                  timeout=3, progress_paths=[self.vault / "absent.md"], progress_timeout=0.15,
                                  max_reconnections=1)
                self.assertEqual(caught.exception.stop_reason, "connection_retry_limit")

    def test_timeout_log_identifies_planning_phase_without_serializing_prompt(self):
        for phase, expected_stage in [("plan", "planning"), ("draft", "generation")]:
            with self.subTest(phase=phase):
                config = {**self.config, "codex_path": "fake", "forge_token_budget": None,
                          "_forge_usage": {"tokens": 0}}
                error = subprocess.TimeoutExpired(["fake", "PRIVATE PROMPT"], 30, output="progress", stderr="")
                with mock.patch.object(P, "run_process", side_effect=error):
                    with self.assertRaises(subprocess.TimeoutExpired) as caught:
                        P.codex_command(config, f"PRIVATE PROMPT\n\nPHASE_OVERRIDE: {phase}. Continue", f"last-{phase}-TEST")
                path = P.write_timeout_run_log(config, "ingest", self.task["id"], "generation", caught.exception)
                text = path.read_text()
                self.assertIn(f"stage={expected_stage}\n", text)
                self.assertNotIn("PRIVATE PROMPT", text)

    def test_ingest_preserves_each_stop_reason_instead_of_generic_deadline(self):
        for reason in ("artifact_stalled", "connection_retry_limit", "wall_deadline_exceeded"):
            with self.subTest(reason=reason):
                source = self.vault / self.task["source_path"]
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_bytes(b"fixture PDF")
                task = {**self.task, "sha256": P.file_sha256(source)}
                P.save_queue(self.config, {"items": [task]})
                error = subprocess.TimeoutExpired(["fake"], 713, output="analysis", stderr="")
                error.stop_reason = reason
                with mock.patch.object(P, "ensure_paper_skills", return_value=["forge-paper-note"]), mock.patch.object(P, "ensure_forge_python", return_value=sys.executable), mock.patch.object(P, "extract_pdf", return_value=self.vault / task["extract_path"]), mock.patch.object(P, "generate_forge", side_effect=error):
                    self.assertEqual(P.ingest_next(self.config), 1)
                saved = P.load_queue(self.config)["items"][0]
                self.assertEqual(saved["failure_kind"], reason)
                self.assertIn(reason, saved["last_error"])
                self.assertNotIn("reached its deadline before", saved["last_error"])
                self.assertFalse((self.vault / task["note_path"]).exists())

    def test_collection_priority_and_explicit_note_selection(self):
        tasks = [dict(self.task, id="other", note_path="wiki/papers/other.md", collection_path="DEA"),
                 dict(self.task, id="adaptive", note_path="wiki/papers/adaptive.md", collection_path="自适应聚合物网络/子目录")]
        for priorities, selected, expected in [([], None, "other"), (["自适应聚合物网络"], None, "adaptive"), (["自适应聚合物网络"], tasks[0]["note_path"], "other")]:
            P.save_queue(self.config, {"items": tasks})
            with mock.patch.object(P, "reconcile_before_generation", return_value=True) as reconcile:
                self.assertEqual(P.ingest_next({**self.config, "ingest_priority_collections": priorities}, selected), 0)
                self.assertEqual(reconcile.call_args.args[1]["id"], expected)

    def test_disproved_publication_metadata_can_be_cleared_without_guessing_year(self):
        task = dict(self.task, title="Front Matter", doi="10.15578/wrong", journal="Wrong journal", year="2016")
        P.save_queue(self.config, {"items": [task]})
        P.identify_queued_paper(self.config, task["id"], "Verified PDF title", "First Author", "unknown", clear_publication=True, additional_authors=["Second Author"])
        saved = P.load_queue(self.config)["items"][0]
        self.assertEqual(saved["creators"], ["First Author", "Second Author"])
        self.assertEqual(saved["year"], "")
        self.assertEqual(saved["doi"], "")
        self.assertEqual(saved["journal"], "")
        self.assertNotIn("doi:", saved["paper_identity"])
        self.assertEqual(saved["source_metadata_overrides"]["doi"], "")
        manifest = self.vault / "sources/literature/manifests/zotero-doc.json"
        P.atomic_write_json(manifest, {"items": [{"active": True}]})
        wrong = dict(task, paper_identity="doi:10.15578/wrong", issn="wrong", collection_path="")
        with mock.patch.object(P, "paper_task", return_value=wrong), mock.patch.object(P, "organize_paper_collections", return_value=0):
            P.scan_sources(self.config)
        refreshed = P.load_queue(self.config)["items"][0]
        self.assertEqual(refreshed["journal"], "")
        self.assertNotIn("doi:", refreshed["paper_identity"])


if __name__ == "__main__":
    unittest.main()

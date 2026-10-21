"""Exercise the pipeline's local-knowledge consumers without running a model."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock


MODULE = Path(__file__).resolve().parents[1] / "knowledge-base/system/knowledge/run_pipeline.py"
SPEC = importlib.util.spec_from_file_location("pipeline_knowledge_consumer", MODULE)
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)


class PipelineKnowledgeConsumerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.vault = Path(self.temporary.name) / "vault"
        self.config = {
            "vault": self.vault,
            "local_state_dir": Path(self.temporary.name) / "local-state",
            "codex_path": "/fixture/never-executed-codex",
            "codex_timeout_seconds": 60,
            "ingest_paused": True,
        }
        self.note_path = "wiki/papers/Networks/Paper.md"
        self.canonical_path = "wiki/concepts/Network.md"
        self.source_path = "sources/literature/pdf/network.pdf"
        self.write(self.source_path, b"PDF fixture; no extraction required")
        self.write("extracts/papers/network.md", "# Source text\n")
        self.write("wiki/papers/Other.md", "# Other paper\n")
        self.write("wiki/index.md", "# Wiki\n\n## 待审核草稿\n\n"
                   f"- [[{self.note_path.removesuffix('.md')}|Network paper]]\n"
                   "- [[wiki/papers/Other|Other]]\n\n## 已整合来源\n\n"
                   "Keep this index commentary.\n")
        self.canonical_before = (
            '---\ntype: concept\ntitle: Network\ncreated: 2026-01-01\n'
            'sources: ["older.pdf"]\ntags: [polymer]\nrelated: [Crosslink]\n---\n'
            '# Network\n\nEarlier evidence. <!-- kb-claim:claim-older --> '
            '[[sources/literature/pdf/older.pdf#page=1|p.1]]\n\n'
            '<!-- user-notes:start -->\nHuman comparison\n<!-- user-notes:end -->\n'
        )
        self.write(self.canonical_path, self.canonical_before)
        self.write("AGENTS.md", "# Vault rules\n")
        self.write("system/workflows/integrate.md", "# Integrate reviewed evidence only\n")
        self.write("system/knowledge/result.schema.json", "{}\n")
        self.write("system/knowledge/config.json", json.dumps({"ingest_paused": True}))
        self.install_reviewed_note()
        self.assert_review_is_current()
        self.model_workspaces = []
        self.model_claims = []

    def write(self, relative, content):
        path = self.vault / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode())
        return path

    def install_reviewed_note(self, *, experiment=False):
        if experiment:
            self.note_path = "wiki/experiments/Run.md"
            self.source_path = "笔记/实验笔记/run.md"
            self.write(self.source_path, "# Results\nObserved relaxation.\n")
            kind, evidence = "experiment", f"{self.source_path}#Results"
        else:
            kind, evidence = "paper", f"{self.source_path}#page=2"
        text = (
            f'---\ntype: {kind}\nstatus: reviewed\nreviewed: true\n'
            'validation_status: passed\nvalidation_warnings: []\n'
            'review_warnings_accepted: false\ntitle: Network paper\n'
            'doi: "10.1234/network"\n'
            '---\n# Network paper\n\nAn unchanged source-note explanation.\n\n'
            '## 可验证的知识声明\n\n'
            f'- Network relaxation depends on the loading conditions. [[{evidence}\\|source]]\n\n'
            '## 人工复核\n\n- [x] Source conditions checked.\n\n'
            '<!-- user-notes:start -->\nHuman source annotation.\n<!-- user-notes:end -->\n'
        )
        note = self.write(self.note_path, text)
        P.update_frontmatter_scalars(note, {"reviewed_content_sha256": P.review_content_hash(text)})
        self.task = {
            "id": "experiment:RUN:version" if experiment else "paper:TEST:version",
            "kind": kind,
            "status": "reviewed",
            "note_path": self.note_path,
            "title": "Network paper",
            "source_path": self.source_path,
            "sha256": hashlib.sha256((self.vault / self.source_path).read_bytes()).hexdigest(),
            "paper_identity": "doi:10.1234/network",
            "source_identity": "experiment:" + self.source_path if experiment else "paper:TEST",
        }
        P.save_queue(self.config, {"items": [self.task, {"id": "pending:OTHER", "status": "pending"}]})

    def assert_review_is_current(self):
        P.validate_review_gate((self.vault / self.note_path).read_text())

    def critical_snapshot(self):
        paths = [self.note_path, self.source_path, self.canonical_path,
                 "wiki/index.md", "wiki/papers/Other.md", "system/queue/pending.json",
                 "system/knowledge/config.json"]
        return {path: (self.vault / path).read_bytes() for path in paths}

    def assert_snapshot_unchanged(self, before):
        for path, data in before.items():
            self.assertEqual((self.vault / path).read_bytes(), data, path)

    def model(self, command, **kwargs):
        """The actual CLI consumer hands the model a candidate cwd and prompt."""
        workspace = Path(command[command.index("-C") + 1])
        self.assertNotEqual(workspace, self.vault)
        self.assertEqual(kwargs["cwd"], str(workspace))
        self.assertTrue(workspace.is_relative_to(self.vault / "system/runtime/integration"))
        self.assertEqual((workspace / self.note_path).read_bytes(),
                         (self.vault / self.note_path).read_bytes())
        self.assertEqual((workspace / "wiki/index.md").read_bytes(),
                         (self.vault / "wiki/index.md").read_bytes())
        self.assertFalse((workspace / self.note_path).stat().st_mode & 0o222)
        self.assertFalse((workspace / "wiki/index.md").stat().st_mode & 0o222)
        self.assertEqual(Path(command[command.index("-o") + 1]).parent,
                         workspace / "system/runtime")
        self.assertIn("原始资料、来源笔记、其他论文、wiki/index.md", command[-1])
        claims, _ = json.JSONDecoder().raw_decode(command[-1].split("CLAIMS_JSON:\n", 1)[1])
        self.assertEqual(len(claims), 1)
        self.assertEqual(claims[0]["primary_note"], self.note_path)
        self.model_claims.append(claims)
        marker, evidence = claims[0]["claim_id"], claims[0]["evidence"][0]
        target = workspace / self.canonical_path
        target.write_text(target.read_text() +
                          f'\nThe result is conditioned on loading. <!-- kb-claim:{marker} --> '
                          f'[[{evidence}|source]] [[{self.note_path}|Reviewed note]]\n')
        self.model_workspaces.append(workspace)
        return subprocess.CompletedProcess(command, 0,
                                           '{"operation":"integrate","status":"reported"}', "")

    def integrate_with(self, model):
        with mock.patch.object(P, "run_process", side_effect=model) as process:
            result = P.integrate_note(self.config, self.note_path)
        self.assertEqual(process.call_count, 1)
        return result

    def test_actual_cli_consumer_stages_and_publishes_reviewed_integration(self):
        before = self.critical_snapshot()
        fingerprint = P.review_content_hash(before[self.note_path].decode())
        self.assertEqual(self.integrate_with(self.model), 0)
        source_note = (self.vault / self.note_path).read_text()
        self.assertEqual(P.note_status(self.vault / self.note_path), "integrated")
        self.assertEqual(P.review_content_hash(source_note), fingerprint)
        self.assertEqual(re.split(r"\n---\n", source_note, maxsplit=1)[1],
                         re.split(r"\n---\n", before[self.note_path].decode(), maxsplit=1)[1])
        fields = P.yaml_frontmatter_scalars(source_note)
        self.assertTrue(P.yaml_boolean(fields["reviewed"]))
        self.assertEqual(P.unquote_yaml_scalar(fields["reviewed_content_sha256"]), fingerprint)
        self.assertIn("integrated_at", fields)
        index = (self.vault / "wiki/index.md").read_text()
        self.assertIn("Keep this index commentary.", index)
        self.assertIn("— 已审核整合", index)
        draft_block = index.split("## 待审核草稿", 1)[1].split("## ", 1)[0]
        self.assertNotIn(self.note_path.removesuffix('.md'), draft_block)
        self.assertIn(self.canonical_path.removesuffix('.md'), index)
        queue = P.load_queue(self.config)
        task = next(item for item in queue["items"] if item["id"] == self.task["id"])
        self.assertEqual(task["status"], "integrated")
        self.assertEqual(queue["items"][1]["status"], "pending")
        report = json.loads((self.vault / task["integration_report_path"]).read_text())
        self.assertEqual(report["status"], "published")
        self.assertEqual(report["changed_canonical_pages"], [self.canonical_path])
        self.assertIn("Human comparison", (self.vault / self.canonical_path).read_text())
        self.assertEqual((self.vault / self.source_path).read_bytes(), before[self.source_path])
        self.assertEqual((self.vault / "system/knowledge/config.json").read_bytes(),
                         before["system/knowledge/config.json"])
        self.assertTrue(self.config["ingest_paused"])

    def test_model_failure_retains_candidate_without_publication(self):
        before = self.critical_snapshot()

        def fail(command, **kwargs):
            self.model(command, **kwargs)
            return subprocess.CompletedProcess(command, 1, "", "Fixture model failure")

        with self.assertRaisesRegex(RuntimeError, "candidate retained"):
            self.integrate_with(fail)
        self.assert_snapshot_unchanged(before)
        self.assertTrue((self.model_workspaces[0] / self.canonical_path).is_file())

    def test_successful_no_op_does_not_claim_integration(self):
        before = self.critical_snapshot()

        def no_op(command, **kwargs):
            result = self.model(command, **kwargs)
            (self.model_workspaces[-1] / self.canonical_path).write_text(self.canonical_before)
            return result

        with self.assertRaisesRegex(RuntimeError, "no canonical changes"):
            self.integrate_with(no_op)
        self.assert_snapshot_unchanged(before)
        self.assertEqual(P.note_status(self.vault / self.note_path), "reviewed")
        self.assertTrue(self.model_workspaces[-1].is_dir())

    def test_publication_failure_rolls_back_source_index_and_canonical(self):
        import integration_candidate
        before = self.critical_snapshot()
        original_writer = integration_candidate._atomic_write
        calls = 0

        def fail_source_write(path, data):
            nonlocal calls
            calls += 1
            if calls == 3:
                raise OSError("Fixture source lifecycle write failure")
            original_writer(path, data)

        with mock.patch.object(integration_candidate, "_atomic_write", side_effect=fail_source_write):
            with self.assertRaisesRegex(RuntimeError, "publish_failed"):
                self.integrate_with(self.model)
        self.assert_snapshot_unchanged(before)
        self.assertTrue((self.model_workspaces[-1] / self.canonical_path).is_file())

    def test_source_or_index_candidate_tampering_does_not_publish(self):
        for relative in [self.note_path, "wiki/index.md", "wiki/papers/Other.md"]:
            with self.subTest(relative=relative):
                before = self.critical_snapshot()

                def tamper(command, **kwargs):
                    result = self.model(command, **kwargs)
                    workspace = self.model_workspaces[-1]
                    P.atomic_write_text(workspace / relative, "Model rewrote a readonly input")
                    return result

                with self.assertRaisesRegex(RuntimeError, "readonly_input_changed"):
                    self.integrate_with(tamper)
                self.assert_snapshot_unchanged(before)

    def test_unknown_claim_candidate_does_not_publish(self):
        before = self.critical_snapshot()

        def unknown_claim(command, **kwargs):
            result = self.model(command, **kwargs)
            target = self.model_workspaces[-1] / self.canonical_path
            target.write_text(target.read_text() + '\n<!-- kb-claim:claim-invented -->\n')
            return result

        with self.assertRaisesRegex(RuntimeError, "unknown_claim"):
            self.integrate_with(unknown_claim)
        self.assert_snapshot_unchanged(before)

    def test_concurrent_live_input_change_is_preserved_and_stops_publication(self):
        before = self.critical_snapshot()

        def concurrent_edit(command, **kwargs):
            result = self.model(command, **kwargs)
            self.write("wiki/papers/Other.md", "Human concurrent edit\n")
            return result

        with self.assertRaisesRegex(RuntimeError, "edit_conflict"):
            self.integrate_with(concurrent_edit)
        for path in [self.note_path, self.canonical_path, "wiki/index.md", "system/queue/pending.json"]:
            self.assertEqual((self.vault / path).read_bytes(), before[path])
        self.assertEqual((self.vault / "wiki/papers/Other.md").read_text(), "Human concurrent edit\n")

    def test_runner_restores_human_blocks_before_validation(self):
        def omit_human_block(command, **kwargs):
            result = self.model(command, **kwargs)
            path = self.model_workspaces[-1] / self.canonical_path
            text = re.sub(r'<!-- user-notes:start -->.*?<!-- user-notes:end -->',
                          '<!-- user-notes:start -->Invented text<!-- user-notes:end -->',
                          path.read_text(), flags=re.S)
            path.write_text(text)
            return result

        self.assertEqual(self.integrate_with(omit_human_block), 0)
        text = (self.vault / self.canonical_path).read_text()
        self.assertIn("Human comparison", text)
        self.assertNotIn("Invented text", text)

    def test_stale_review_stops_before_cli_call_or_candidate_creation(self):
        note = self.vault / self.note_path
        note.write_text(note.read_text() + "An edit made after review.\n")
        before = self.critical_snapshot()
        with mock.patch.object(P, "run_process") as process:
            with self.assertRaisesRegex(RuntimeError, "stale"):
                P.integrate_note(self.config, self.note_path)
            process.assert_not_called()
        self.assert_snapshot_unchanged(before)
        self.assertFalse((self.vault / "system/runtime/integration").exists())

    def test_experiment_consumer_uses_original_markdown_locator(self):
        self.install_reviewed_note(experiment=True)
        self.assert_review_is_current()
        fingerprint = P.review_content_hash((self.vault / self.note_path).read_text())
        actual_claims = P.claim_records((self.vault / self.note_path).read_text(), self.task)
        self.assertEqual(actual_claims[0]["source_kind"], "experiment")
        self.assertEqual(actual_claims[0]["evidence"], [f"{self.source_path}#Results"])
        self.assertEqual(self.integrate_with(self.model), 0)
        self.assertIn(f"[[{self.source_path}#Results|source]]",
                      (self.vault / self.canonical_path).read_text())
        self.assertEqual(P.review_content_hash((self.vault / self.note_path).read_text()), fingerprint)

    def test_experiment_without_original_locator_does_not_start_model(self):
        self.install_reviewed_note(experiment=True)
        text = (self.vault / self.note_path).read_text().replace('#Results', '')
        note = self.write(self.note_path, text)
        P.update_frontmatter_scalars(note, {"reviewed_content_sha256": P.review_content_hash(text)})
        with mock.patch.object(P, "run_process") as process:
            with self.assertRaisesRegex(RuntimeError, "No source-located claims"):
                P.integrate_note(self.config, self.note_path)
            process.assert_not_called()

    def test_no_matching_queue_paper_uses_reviewed_frontmatter_identity(self):
        note = self.vault / self.note_path
        P.update_frontmatter_scalars(note, {
            "source_id": self.task["id"], "paper_identity": self.task["paper_identity"],
            "source_pdf": f"[[{self.source_path}]]", "source_sha256": self.task["sha256"],
        })
        P.update_frontmatter_scalars(note, {"reviewed_content_sha256": P.review_content_hash(note.read_text())})
        expected = P.claim_records(note.read_text(), self.task)
        P.save_queue(self.config, {"items": [{"id": "pending:OTHER", "status": "pending"}]})
        queue_before = P.queue_path(self.config).read_bytes()
        self.assertEqual(self.integrate_with(self.model), 0)
        self.assertEqual(self.model_claims[-1], expected)
        self.assertEqual(P.queue_path(self.config).read_bytes(), queue_before)
        self.assertEqual(P.note_status(note), "integrated")

    def test_no_queue_experiment_uses_reviewed_original_note_location(self):
        self.install_reviewed_note(experiment=True)
        note = self.vault / self.note_path
        P.update_frontmatter_scalars(note, {
            "source_id": self.task["id"], "source_note": f"[[{self.source_path}]]",
            "source_sha256": self.task["sha256"],
        })
        P.update_frontmatter_scalars(note, {"reviewed_content_sha256": P.review_content_hash(note.read_text())})
        expected = P.claim_records(note.read_text(), self.task)
        P.queue_path(self.config).unlink()
        self.assertEqual(self.integrate_with(self.model), 0)
        self.assertEqual(self.model_claims[-1], expected)
        self.assertFalse(P.queue_path(self.config).exists())
        self.assertEqual(P.note_status(note), "integrated")

    def test_knowledge_cli_is_local_and_does_not_resume_paused_generation(self):
        before = self.critical_snapshot()
        commands = [
            ["runner", "knowledge-context", "--question", "network relaxation"],
            ["runner", "knowledge-map"],
            ["runner", "knowledge-map", "--report"],
        ]
        for argv in commands:
            with self.subTest(argv=argv), mock.patch.object(sys, "argv", argv), \
                    mock.patch.object(P, "load_config", return_value=self.config), \
                    mock.patch.object(P, "codex_command") as model, \
                    mock.patch.object(P, "ingest_next") as ingest, \
                    mock.patch.object(P, "generate_forge") as generate:
                output = io.StringIO()
                with redirect_stdout(output):
                    self.assertEqual(P.main(), 0)
                payload = json.loads(output.getvalue())
                model.assert_not_called()
                ingest.assert_not_called()
                generate.assert_not_called()
                self.assertTrue(self.config["ingest_paused"])
                self.assert_snapshot_unchanged(before)
                if "knowledge-context" in argv:
                    self.assertTrue(payload["results"])
                else:
                    self.assertTrue(payload["nodes"])
        report = self.vault / "system/reports/local-knowledge-map.md"
        self.assertTrue(report.is_file())
        self.assertIn("不是证据置信度", report.read_text())


if __name__ == "__main__":
    unittest.main()

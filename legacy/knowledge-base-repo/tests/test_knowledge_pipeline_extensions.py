"""Exercise report commands and multiple reviewed-source integration consumers."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from unittest import mock


SPEC = importlib.util.spec_from_file_location("knowledge_extension_fixture", Path(__file__).with_name("test_pipeline_knowledge.py"))
FIXTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FIXTURE)
P = FIXTURE.P


class KnowledgePipelineExtensionTests(unittest.TestCase):
    def setUp(self):
        self.f = FIXTURE.PipelineKnowledgeConsumerTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.other_note = "wiki/papers/Other.md"
        self.other_source = "sources/literature/pdf/other.pdf"
        source = self.f.write(self.other_source, b"second independent PDF fixture")
        digest = P.file_sha256(source)
        self.other_task = {"id": "paper:OTHER:version", "kind": "paper", "note_path": self.other_note,
                           "title": "Network relaxation comparison", "status": "reviewed",
                           "source_path": self.other_source, "sha256": digest,
                           "paper_identity": "doi:10.1234/other"}
        self.write_other_review()
        P.save_queue(self.f.config, {"items": [self.f.task, self.other_task]})

    def write_other_review(self):
        text = ('---\ntype: paper\ntitle: Network relaxation comparison\n'
                'status: reviewed\nreviewed: true\nvalidation_status: passed\nvalidation_warnings: []\n'
                'doi: 10.1234/other\n'
                f'source_pdf: "[[{self.other_source}]]"\nsource_sha256: {self.other_task["sha256"]}\n'
                '---\n# Network relaxation comparison\n\n## 可验证的知识声明\n\n'
                f'- Network relaxation was measured under a different loading condition. [[{self.other_source}#page=3|p.3]]\n\n'
                '## 人工复核\n- [x] Conditions checked.\n')
        path = self.f.write(self.other_note, text)
        P.update_frontmatter_scalars(path, {"reviewed_content_sha256": P.review_content_hash(text)})

    def compare_model(self, command, **kwargs):
        workspace = Path(command[command.index("-C") + 1])
        self.assertNotEqual(workspace, self.f.vault)
        claims, _ = json.JSONDecoder().raw_decode(command[-1].split("CLAIMS_JSON:\n", 1)[1])
        self.assertEqual({claim["primary_note"] for claim in claims}, {self.f.note_path, self.other_note})
        packet = json.loads((workspace.parent / "evidence-packet.json").read_text())
        self.assertTrue(packet["evidence_comparison"]["can_integrate"])
        target = workspace / "wiki/synthesis/Network comparison.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        rows = ["# Network comparison", "", "| Claim and conditions | Evidence |", "| --- | --- |"]
        for claim in claims:
            rows.append(f'| Conditioned result <!-- kb-claim:{claim["claim_id"]} --> | '
                        f'[[{claim["evidence"][0]}\\|page]] [[{claim["primary_note"]}\\|reviewed source]] |')
        target.write_text("\n".join(rows) + "\n")
        return subprocess.CompletedProcess(command, 0, '{"operation":"integrate","status":"reported"}', "")

    def test_multiple_reviewed_claims_publish_with_each_original_source_and_preserve_other_lifecycle(self):
        other_before = (self.f.vault / self.other_note).read_bytes()
        with mock.patch.object(P, "run_process", side_effect=self.compare_model):
            self.assertEqual(P.integrate_note(self.f.config, self.f.note_path), 0)
        comparison = (self.f.vault / "wiki/synthesis/Network comparison.md").read_text()
        self.assertIn(self.other_source + "#page=3", comparison)
        self.assertIn(self.other_note, comparison)
        self.assertEqual((self.f.vault / self.other_note).read_bytes(), other_before)
        queue = P.load_queue(self.f.config)["items"]
        self.assertEqual(queue[0]["status"], "integrated")
        self.assertEqual(queue[1]["status"], "reviewed")
        self.assertTrue(self.f.config["ingest_paused"])

    def test_stale_reviewed_secondary_source_never_enters_claim_packet(self):
        note = self.f.vault / self.other_note
        note.write_text(note.read_text() + "Edited after review.\n")
        with mock.patch.object(P, "run_process", side_effect=self.f.model):
            self.assertEqual(P.integrate_note(self.f.config, self.f.note_path), 0)
        self.assertEqual(len(self.f.model_claims[-1]), 1)

    def test_secondary_original_pdf_edit_during_model_prevents_publication(self):
        before = self.f.critical_snapshot()
        def changed(command, **kwargs):
            result = self.compare_model(command, **kwargs)
            (self.f.vault / self.other_source).write_bytes(b"concurrent new PDF")
            return result
        with mock.patch.object(P, "run_process", side_effect=changed):
            with self.assertRaisesRegex(RuntimeError, "input_changed"):
                P.integrate_note(self.f.config, self.f.note_path)
        self.f.assert_snapshot_unchanged(before)
        self.assertFalse((self.f.vault / "wiki/synthesis/Network comparison.md").exists())
        self.assertEqual((self.f.vault / self.other_source).read_bytes(), b"concurrent new PDF")

    def test_secondary_claim_cannot_link_to_current_primary_instead(self):
        before = self.f.critical_snapshot()
        def wrong_backlink(command, **kwargs):
            result = self.compare_model(command, **kwargs)
            target = Path(kwargs["cwd"]) / "wiki/synthesis/Network comparison.md"
            target.write_text(target.read_text().replace(self.other_note, self.f.note_path))
            return result
        with mock.patch.object(P, "run_process", side_effect=wrong_backlink):
            with self.assertRaisesRegex(RuntimeError, "claim_note_mismatch"):
                P.integrate_note(self.f.config, self.f.note_path)
        self.f.assert_snapshot_unchanged(before)

    def test_source_drift_between_collection_and_snapshot_never_starts_model(self):
        import integration_candidate
        prepare = integration_candidate.prepare_integration_candidate
        def changed_before_snapshot(*args, **kwargs):
            (self.f.vault / self.other_source).write_bytes(b"changed before preparation")
            return prepare(*args, **kwargs)
        with mock.patch.object(integration_candidate, "prepare_integration_candidate", side_effect=changed_before_snapshot), mock.patch.object(P, "run_process") as model:
            with self.assertRaisesRegex(RuntimeError, "before candidate preparation"):
                P.integrate_note(self.f.config, self.f.note_path)
        model.assert_not_called()
        self.assertEqual(P.note_status(self.f.vault / self.f.note_path), "reviewed")

    def test_question_evidence_updates_while_human_status_priority_and_notes_remain(self):
        question = "wiki/questions/Network relaxation.md"
        self.f.write(question, '---\ntype: question\nstatus: open\nquestion_status: open\npriority: high\n---\n# Network relaxation\n\n<!-- user-notes:start -->\nMy next experiment.\n<!-- user-notes:end -->\n')
        def update_question(command, **kwargs):
            result = self.compare_model(command, **kwargs)
            workspace = Path(kwargs['cwd'])
            target = workspace / question
            target.write_text(target.read_text() + '\n## 已知证据\n\n' +
                              (workspace / "wiki/synthesis/Network comparison.md").read_text())
            return result
        with mock.patch.object(P, "run_process", side_effect=update_question):
            self.assertEqual(P.integrate_note(self.f.config, self.f.note_path), 0)
        result = (self.f.vault / question).read_text()
        self.assertIn('status: open', result)
        self.assertIn('priority: high', result)
        self.assertIn('My next experiment.', result)
        self.assertIn(self.other_source + '#page=3', result)

    def test_all_report_cli_consumers_are_model_free_and_preserve_source_queue_and_pause(self):
        before = self.f.critical_snapshot()
        commands = [(["compare-evidence", "--question", "network relaxation", "--note", self.f.note_path, "--report"], "evidence-comparison.md"),
                    (["maintain-concepts", "--report"], "concept-maintenance.md"),
                    (["maintain-questions", "--report"], "research-question-maintenance.md")]
        for arguments, report in commands:
            with self.subTest(command=arguments[0]):
                output = io.StringIO()
                with mock.patch.object(P, "load_config", return_value=self.f.config), mock.patch.object(P, "run_process") as model, mock.patch.object(sys, "argv", ["pipeline", *arguments]), redirect_stdout(output):
                    self.assertEqual(P.main(), 0)
                model.assert_not_called()
                payload = json.loads(output.getvalue())
                self.assertEqual(payload["report_path"], "system/reports/" + report)
                self.assertTrue((self.f.vault / payload["report_path"]).is_file())
                self.f.assert_snapshot_unchanged(before)

    def test_report_refresh_preserves_marked_human_annotations(self):
        report = self.f.write("system/reports/evidence-comparison.md", "# Old report\n\n<!-- user-notes:start -->\nKeep human comparison.\n<!-- user-notes:end -->\n")
        with redirect_stdout(io.StringIO()):
            self.assertEqual(P.show_evidence_comparison(self.f.config, "network", None, True), 0)
        self.assertIn("Keep human comparison.", report.read_text())

    def test_empty_comparison_question_does_not_write_report_or_call_model(self):
        with mock.patch.object(P, "run_process") as model:
            with self.assertRaisesRegex(RuntimeError, "研究问题"):
                P.show_evidence_comparison(self.f.config, "  ", None, True)
        model.assert_not_called()
        self.assertFalse((self.f.vault / "system/reports/evidence-comparison.md").exists())

    def test_merge_restores_human_question_status_before_publication(self):
        question = "wiki/questions/Network relaxation.md"
        self.f.write(question, '---\ntype: question\nstatus: open\nquestion_status: open\n---\n# Network relaxation\n')
        def changes(command, **kwargs):
            result = self.compare_model(command, **kwargs)
            workspace = Path(kwargs['cwd'])
            synthesis = (workspace / "wiki/synthesis/Network comparison.md").read_text()
            (workspace / question).write_text('---\ntype: question\nstatus: resolved\nquestion_status: open\n---\n' + synthesis)
            return result
        with mock.patch.object(P, "run_process", side_effect=changes):
            self.assertEqual(P.integrate_note(self.f.config, self.f.note_path), 0)
        self.assertIn('status: open', (self.f.vault / question).read_text())
        runtime = next((self.f.vault / 'system/runtime/integration').glob('*/*'))
        details = json.loads((runtime / 'merge-report.json').read_text())
        self.assertIn('status', details['canonical_pages'][question]['locked_fields_restored'])

    def test_merge_unions_existing_aliases_and_sources_before_publication(self):
        canonical = self.f.vault / self.f.canonical_path
        canonical.write_text(canonical.read_text().replace('sources:', 'aliases: ["network elasticity"]\nsources:', 1))
        def alias_lost(command, **kwargs):
            result = self.compare_model(command, **kwargs)
            workspace = Path(kwargs['cwd'])
            target = workspace / self.f.canonical_path
            extra = (workspace / "wiki/synthesis/Network comparison.md").read_text()
            target.write_text(target.read_text().replace('aliases: ["network elasticity"]\n', '') + extra)
            return result
        with mock.patch.object(P, "run_process", side_effect=alias_lost):
            self.assertEqual(P.integrate_note(self.f.config, self.f.note_path), 0)
        import integration_candidate
        fields = integration_candidate._frontmatter(canonical.read_text())
        self.assertEqual(integration_candidate._list(fields, 'aliases'), ['network elasticity'])
        self.assertIn(self.other_source + '#page=3', canonical.read_text())

    def test_incremental_merge_cannot_rewrite_existing_conditioned_claims(self):
        before = self.f.critical_snapshot()
        def altered(command, **kwargs):
            result = self.compare_model(command, **kwargs)
            workspace = Path(kwargs['cwd'])
            target = workspace / self.f.canonical_path
            target.write_text(target.read_text().replace('Earlier evidence.', 'Earlier evidence at an invented temperature.') +
                              (workspace / 'wiki/synthesis/Network comparison.md').read_text())
            return result
        with mock.patch.object(P, 'run_process', side_effect=altered):
            with self.assertRaisesRegex(RuntimeError, 'existing_claim_changed'):
                P.integrate_note(self.f.config, self.f.note_path)
        self.f.assert_snapshot_unchanged(before)

    def test_new_page_exact_evidence_rows_are_deduplicated_without_a_second_model_call(self):
        def duplicated(command, **kwargs):
            result = self.compare_model(command, **kwargs)
            target = Path(kwargs['cwd']) / 'wiki/synthesis/Network comparison.md'
            row = next(line for line in target.read_text().splitlines() if '<!-- kb-claim:' in line)
            target.write_text(target.read_text() + row + '\n')
            return result
        with mock.patch.object(P, 'run_process', side_effect=duplicated) as model:
            self.assertEqual(P.integrate_note(self.f.config, self.f.note_path), 0)
        self.assertEqual(model.call_count, 1)
        result = (self.f.vault / 'wiki/synthesis/Network comparison.md').read_text()
        self.assertEqual(result.count('<!-- kb-claim:'), 2)

    def test_model_canonical_directory_symlink_cannot_be_written_by_normalization(self):
        before = self.f.critical_snapshot()
        def symlink(command, **kwargs):
            result = self.compare_model(command, **kwargs)
            workspace = Path(kwargs['cwd'])
            (workspace / self.f.canonical_path).unlink()
            (workspace / 'wiki/concepts').rmdir()
            (workspace / 'wiki/concepts').symlink_to(self.f.vault / 'wiki/concepts', target_is_directory=True)
            return result
        with mock.patch.object(P, 'run_process', side_effect=symlink):
            with self.assertRaisesRegex(RuntimeError, 'illegal_symlink'):
                P.integrate_note(self.f.config, self.f.note_path)
        self.f.assert_snapshot_unchanged(before)


if __name__ == "__main__":
    unittest.main()

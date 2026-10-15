import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock


MODULE = Path(__file__).resolve().parents[1] / "knowledge-base/system/knowledge/integration_candidate.py"
SPEC = importlib.util.spec_from_file_location("integration_candidate", MODULE)
I = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(I)


class IntegrationCandidateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.vault = Path(self.temporary.name) / "vault"
        self.note = "wiki/papers/sub/Paper.md"
        self.existing = "wiki/concepts/Elasticity.md"
        self.source = "sources/literature/pdf/paper.pdf"
        self.other_source = "sources/literature/pdf/old.pdf"
        self.original = (
            '---\ntype: concept\ntitle: Elasticity\ncreated: 2026-01-01\n'
            'sources: ["old.pdf"]\ntags:\n  - mechanics\nrelated: [Network]\n---\n'
            '# Elasticity\n\nOld result. <!-- kb-claim:claim-old --> '
            '[[sources/literature/pdf/old.pdf#page=1|p.1]]\n\n'
            '<!-- user-notes:start -->\nMy observation\n<!-- user-notes:end -->\n'
        )
        self.write(self.note, '---\ntype: paper\nstatus: reviewed\nreviewed: true\n---\n'
                   f'# Paper\n[[{self.source}#page=2|p.2]]\n'
                   '[[extracts/papers/paper.md]]\n')
        self.write("wiki/papers/Other.md", "# Other paper\n")
        self.write("wiki/index.md", "# Index\n")
        self.write(self.existing, self.original)
        self.write(self.source, "PDF current")
        self.write(self.other_source, "PDF old")
        self.write("extracts/papers/paper.md", "# Source extract\n")
        self.write("wiki/papers/images/Paper/caption.md", "# Asset\n")
        self.write("wiki/papers/close-reading/Paper.md", "# Learning\n")
        for path in I.INSTRUCTION_PATHS:
            self.write(path, "{}" if path.endswith(".json") else "# Instructions\n")
        self.claims = [{"claim_id": "claim-new", "primary_note": self.note,
                        "evidence": [f"{self.source}#page=2"]}]
        self.workspace, self.baselines = I.prepare_integration_candidate(
            self.vault, Path(self.temporary.name) / "runtime", self.note)

    def write(self, relative, text):
        path = self.vault / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def proposal(self, relative=None, additional=""):
        relative = relative or self.existing
        content = self.original if relative == self.existing else '# New page\n'
        content += (f'\nCurrent result. <!-- kb-claim:claim-new --> '
                    f'[[{self.source}#page=2|p.2]] [[{self.note}|Paper]]\n' + additional)
        path = self.workspace / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def validate(self):
        return I.validate_integration_candidate(self.vault, self.workspace,
                                                self.baselines, self.note, self.claims)

    def test_prepare_limits_copied_inputs_and_tracks_sources(self):
        self.assertTrue((self.workspace / "sources").is_symlink())
        self.assertTrue((self.workspace / "extracts").is_symlink())
        self.assertNotIn("wiki/papers/images/Paper/caption.md", self.baselines)
        self.assertNotIn("wiki/papers/close-reading/Paper.md", self.baselines)
        self.assertEqual(self.baselines[self.source], b"PDF current")
        self.assertEqual(self.baselines["extracts/papers/paper.md"], b"# Source extract\n")

    def test_valid_proposal_publishes_only_canonical_pages(self):
        self.proposal()
        self.proposal("wiki/materials/Elastomer.md")
        changed = self.validate()
        self.assertEqual(changed, [self.existing, "wiki/materials/Elastomer.md"])
        before = (self.vault / self.note).read_bytes()
        I.publish_integration_candidate(self.vault, self.workspace, self.baselines, changed)
        self.assertIn("claim-new", (self.vault / self.existing).read_text())
        self.assertEqual((self.vault / self.note).read_bytes(), before)

    def test_source_index_and_other_note_are_readonly(self):
        for relative in [self.note, "wiki/index.md", "wiki/papers/Other.md"]:
            with self.subTest(relative=relative):
                path = self.workspace / relative
                before = path.read_bytes()
                path.chmod(0o644)
                path.write_text("Changed by generation")
                with self.assertRaisesRegex(RuntimeError, "readonly_input_changed"):
                    self.validate()
                path.write_bytes(before)

    def test_deletion_and_unauthorized_new_files_are_rejected(self):
        target = self.workspace / self.existing
        target.unlink()
        with self.assertRaisesRegex(RuntimeError, "deleted_input"):
            self.validate()
        target.write_text(self.original)
        for relative in ["wiki/papers/New.md", "wiki/concepts/code.py", "unauthorized.md"]:
            with self.subTest(relative=relative):
                path = self.workspace / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("Unapproved")
                with self.assertRaisesRegex(RuntimeError, "unauthorized_write"):
                    self.validate()
                path.unlink()

    def test_illegal_directory_and_symlink_are_rejected(self):
        directory = self.workspace / "wiki/unsafe"
        directory.mkdir()
        with self.assertRaisesRegex(RuntimeError, "illegal_directory"):
            self.validate()
        directory.rmdir()
        path = self.workspace / "wiki/concepts/Outside.md"
        path.symlink_to(self.vault / self.note)
        with self.assertRaisesRegex(RuntimeError, "illegal_file"):
            self.validate()

    def test_cli_runtime_reports_are_allowed_without_publication(self):
        path = self.workspace / "system/runtime/result.json"
        path.parent.mkdir(parents=True)
        path.write_text("{}")
        self.proposal()
        self.assertEqual(self.validate(), [self.existing])

    def test_provenance_links_and_old_claims_cannot_be_lost(self):
        for old, replacement, error in [
            ("<!-- kb-claim:claim-old -->", "", "old_claim_lost"),
            ('[[sources/literature/pdf/old.pdf#page=1|p.1]]', "", "source_link_lost"),
            ('sources: ["old.pdf"]', 'sources: ["new.pdf"]', "provenance_lost"),
            ('  - mechanics', '  - different', "provenance_lost"),
            ('related: [Network]', 'related: []', "provenance_lost"),
        ]:
            with self.subTest(error=error, old=old):
                path = self.proposal()
                path.write_text(path.read_text().replace(old, replacement))
                with self.assertRaisesRegex(RuntimeError, error):
                    self.validate()

    def test_metadata_union_and_locked_scalar_values(self):
        path = self.proposal()
        path.write_text(path.read_text().replace('sources: ["old.pdf"]',
                                                'sources: ["old.pdf", "new.pdf"]'))
        self.assertEqual(self.validate(), [self.existing])
        for field in ['type: concept', 'title: Elasticity', 'created: 2026-01-01']:
            path = self.proposal()
            path.write_text(path.read_text().replace(field, field.split(':')[0] + ': Changed'))
            with self.assertRaisesRegex(RuntimeError, "metadata_changed"):
                self.validate()

    def test_unknown_metadata_list_is_not_silently_discarded(self):
        path = self.proposal()
        path.write_text(path.read_text().replace('sources: ["old.pdf"]',
                                                'sources: {unrecognized: mapping}'))
        with self.assertRaisesRegex(RuntimeError, "metadata_unknown_list"):
            self.validate()

    def test_unknown_claim_wrong_page_and_missing_current_source(self):
        for old, replacement, error in [
            ('kb-claim:claim-new', 'kb-claim:claim-unknown', 'unknown_claim'),
            ('paper.pdf#page=2', 'paper.pdf#page=9', 'claim_page_mismatch'),
            (f'[[{self.note}|Paper]]', '', 'current_evidence_missing'),
        ]:
            path = self.proposal()
            path.write_text(path.read_text().replace(old, replacement))
            with self.assertRaisesRegex(RuntimeError, error):
                self.validate()

    def test_claim_evidence_is_local_to_its_table_row(self):
        path = self.proposal()
        path.write_text(self.original + f'\n[[{self.note}]]\n\n'
                        '| Claim | Evidence |\n|---|---|\n'
                        f'| new <!-- kb-claim:claim-new --> | [[{self.source}#page=9]] |\n'
                        f'| unrelated | [[{self.source}#page=2]] |\n')
        with self.assertRaisesRegex(RuntimeError, "claim_page_mismatch"):
            self.validate()

    def test_old_claim_conditions_cannot_change_under_the_same_marker(self):
        path = self.proposal()
        path.write_text(path.read_text().replace('Old result.', 'Old result at a newly invented temperature.'))
        with self.assertRaisesRegex(RuntimeError, "existing_claim_changed"):
            self.validate()

    def test_standalone_old_marker_preserves_following_table_conditions(self):
        old_paragraph = ('Old result. <!-- kb-claim:claim-old --> '
                         '[[sources/literature/pdf/old.pdf#page=1|p.1]]')
        for separator in ('\n', '\n\n'):
            with self.subTest(separator=separator):
                original = self.original.replace(old_paragraph,
                    '<!-- kb-claim:claim-old -->' + separator
                    + '| Condition | Evidence |\n|---|---|\n'
                    + '| At 25 C | [[sources/literature/pdf/old.pdf#page=1|p.1]] |')
                self.write(self.existing, original)
                self.workspace, self.baselines = I.prepare_integration_candidate(
                    self.vault, Path(self.temporary.name) / ('table-runtime-' + str(len(separator))), self.note)
                path = self.proposal()
                proposal = path.read_text().replace(self.original, original)
                path.write_text(proposal)
                self.assertEqual(self.validate(), [self.existing])
                path.write_text(proposal.replace('At 25 C', 'At 55 C'))
                with self.assertRaisesRegex(RuntimeError, "existing_claim_changed"):
                    self.validate()

    def test_old_claim_line_wrapping_is_not_a_condition_change(self):
        path = self.proposal()
        path.write_text(path.read_text().replace('Old result.', 'Old\nresult.'))
        self.assertEqual(self.validate(), [self.existing])

    def test_explicit_correction_with_a_new_marker_keeps_the_original(self):
        path = self.proposal()
        path.write_text(path.read_text().replace('Current result.', 'Current result corrects:claim-old under its own conditions.'))
        self.assertEqual(self.validate(), [self.existing])

    def test_human_content_must_be_preserved(self):
        path = self.proposal()
        path.write_text(path.read_text().replace('My observation', 'Invented observation'))
        with self.assertRaisesRegex(RuntimeError, "human_content_changed"):
            self.validate()

    def test_input_drift_stops_all_publication_before_first_write(self):
        self.proposal()
        changed = self.validate()
        self.write("wiki/papers/Other.md", "Human concurrent edit")
        with mock.patch.object(I, "_atomic_write") as writer:
            with self.assertRaisesRegex(RuntimeError, "edit_conflict"):
                I.publish_integration_candidate(self.vault, self.workspace, self.baselines, changed)
            writer.assert_not_called()
        self.assertEqual((self.vault / self.existing).read_text(), self.original)

    def test_changed_source_input_is_detected(self):
        self.proposal()
        self.write(self.source, "Changed PDF")
        with self.assertRaisesRegex(RuntimeError, "input_changed"):
            self.validate()

    def test_partial_failure_rolls_back_and_keeps_candidate(self):
        self.proposal()
        self.proposal("wiki/materials/New.md")
        changed = self.validate()
        original_writer = I._atomic_write
        calls = 0

        def fail_second(path, data):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("Fixture write failure")
            original_writer(path, data)

        with mock.patch.object(I, "_atomic_write", side_effect=fail_second):
            with self.assertRaisesRegex(RuntimeError, "publish_failed"):
                I.publish_integration_candidate(self.vault, self.workspace, self.baselines, changed)
        self.assertEqual((self.vault / self.existing).read_text(), self.original)
        self.assertFalse((self.vault / "wiki/materials/New.md").exists())
        self.assertTrue((self.workspace / "wiki/materials/New.md").is_file())

    def test_new_live_target_is_not_overwritten(self):
        self.proposal("wiki/materials/New.md")
        changed = self.validate()
        self.write("wiki/materials/New.md", "Human new canonical page")
        with self.assertRaisesRegex(RuntimeError, "edit_conflict"):
            I.publish_integration_candidate(self.vault, self.workspace, self.baselines, changed)
        self.assertEqual((self.vault / "wiki/materials/New.md").read_text(), "Human new canonical page")

    def test_runner_owned_note_and_index_publish_in_the_same_batch(self):
        self.proposal()
        changed = self.validate()
        note = self.workspace / self.note
        note.chmod(0o644)
        note.write_text(note.read_text().replace('status: reviewed', 'status: integrated'))
        index = self.workspace / "wiki/index.md"
        index.chmod(0o644)
        index.write_text("# Integrated sources\n")
        with self.assertRaisesRegex(RuntimeError, "unauthorized_publish"):
            I.publish_integration_candidate(self.vault, self.workspace, self.baselines,
                                            changed + [self.note, 'wiki/index.md'])
        I.publish_integration_candidate(self.vault, self.workspace, self.baselines,
                                        changed + [self.note, 'wiki/index.md'],
                                        runner_owned_paths=[self.note, 'wiki/index.md'])
        self.assertIn('status: integrated', (self.vault / self.note).read_text())
        self.assertEqual((self.vault / 'wiki/index.md').read_text(), "# Integrated sources\n")

    def test_runner_owned_publication_failure_restores_index_and_canonical(self):
        self.proposal()
        changed = self.validate()
        for relative in [self.note, 'wiki/index.md']:
            path = self.workspace / relative
            path.chmod(0o644)
            path.write_text('Runner-managed update\n')
        original_writer = I._atomic_write
        calls = 0

        def fail_source_note(path, data):
            nonlocal calls
            calls += 1
            if calls == 3:
                raise OSError('Source lifecycle update failed')
            original_writer(path, data)

        with mock.patch.object(I, '_atomic_write', side_effect=fail_source_note):
            with self.assertRaisesRegex(RuntimeError, 'publish_failed'):
                I.publish_integration_candidate(self.vault, self.workspace, self.baselines,
                                                changed + [self.note, 'wiki/index.md'],
                                                runner_owned_paths=[self.note, 'wiki/index.md'])
        for relative in [self.existing, self.note, 'wiki/index.md']:
            self.assertEqual((self.vault / relative).read_bytes(), self.baselines[relative])

    def test_rollback_removes_newly_published_canonical_page(self):
        self.proposal('wiki/concepts/A-new.md')
        self.proposal()
        changed = self.validate()
        original_writer = I._atomic_write
        calls = 0

        def fail_second(path, data):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('Second page write failed')
            original_writer(path, data)

        with mock.patch.object(I, '_atomic_write', side_effect=fail_second):
            with self.assertRaisesRegex(RuntimeError, 'publish_failed'):
                I.publish_integration_candidate(self.vault, self.workspace, self.baselines, changed)
        self.assertFalse((self.vault / 'wiki/concepts/A-new.md').exists())
        self.assertEqual((self.vault / self.existing).read_bytes(), self.baselines[self.existing])

    def test_experiment_claim_requires_an_original_markdown_location(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory) / "vault"
            note_path = "wiki/experiments/Run.md"
            raw_path = "笔记/实验笔记/run.md"
            for relative, text in [
                (note_path, f'# Run\n[[{raw_path}#Results]]\n'),
                (raw_path, '# Results\nObservation\n'),
                ('wiki/index.md', '# Index'),
            ] + [(path, '{}') for path in I.INSTRUCTION_PATHS]:
                path = vault / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            workspace, baseline = I.prepare_integration_candidate(vault, Path(directory) / 'runtime', note_path)
            target = workspace / 'wiki/phenomena/Observed.md'
            target.parent.mkdir(parents=True)
            target.write_text(f'# Observed\n\n<!-- kb-claim:claim-exp -->\n'
                              f'Observation [[{note_path}]] [[{raw_path}#Results]]\n')
            claims = [{'claim_id': 'claim-exp', 'primary_note': note_path,
                       'evidence': [f'{raw_path}#Results']}]
            self.assertEqual(I.validate_integration_candidate(vault, workspace, baseline, note_path, claims),
                             ['wiki/phenomena/Observed.md'])
            target.write_text(target.read_text().replace('#Results', '#Unknown'))
            with self.assertRaisesRegex(RuntimeError, 'experiment_location_missing'):
                I.validate_integration_candidate(vault, workspace, baseline, note_path, claims)


if __name__ == "__main__":
    unittest.main()

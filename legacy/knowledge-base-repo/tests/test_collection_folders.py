import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "knowledge-base/system/zotero-sync"))


def module(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


S = module("collection_sync", "knowledge-base/system/zotero-sync/sync_zotero_doc.py")
P = module("collection_pipeline", "knowledge-base/system/knowledge/run_pipeline.py")


class CollectionFoldersTest(unittest.TestCase):
    def test_descendants_are_recursive_safe_and_deduplicated(self):
        collections = [
            {"key": "ROOT", "data": {"name": "Doc", "parentCollection": False}},
            {"key": "A", "data": {"name": "DEA", "parentCollection": "ROOT"}},
            {"key": "B", "data": {"name": "层/级", "parentCollection": "A"}},
            {"key": "C", "data": {"name": "images", "parentCollection": "ROOT"}},
            {"key": "OUT", "data": {"name": "Other", "parentCollection": False}},
        ]
        with mock.patch.object(S, "api_list", return_value=collections):
            paths = S.collection_tree("fixture", "ROOT")
        self.assertEqual(paths, {"ROOT": "", "A": "DEA", "B": "DEA/层_级", "C": "images (C)"})
        paper = {"key": "PAPER", "data": {"collections": ["ROOT", "B", "A"]}}
        self.assertEqual(S.item_collection_paths(paper, paths), ["DEA/层_级", "DEA", ""])
        with mock.patch.object(S, "api_list", return_value=[paper]):
            self.assertEqual(S.collection_items("fixture", paths), [paper])

    def test_api_lists_include_later_pages(self):
        with mock.patch.object(S, "api_json", side_effect=[[{"key": str(i)} for i in range(100)], [{"key": "last"}]]) as fetch:
            self.assertEqual(len(S.api_list("fixture", "users/0/items?format=json")), 101)
            self.assertIn("start=100", fetch.call_args.args[1])

    def test_organize_sync_includes_child_pdfs_bibliography_and_holds_new_tasks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vault = root / "vault"
            vault.mkdir()
            source = root / "source.pdf"
            source.write_bytes(b"test PDF")
            config_path = root / "config.json"
            config_path.write_text(json.dumps({"api_base": "fixture", "collection_name": "Doc", "collection_key": "ROOT",
                                               "vault_path": str(vault), "literature_dir": "sources/literature"}))
            paths = {"ROOT": "", "CHILD": "DEA"}
            items = [
                {"key": "PARENT", "data": {"itemType": "journalArticle", "title": "New paper", "collections": ["CHILD"]}},
                {"key": "PDF", "data": {"itemType": "attachment", "contentType": "application/pdf", "parentItem": "PARENT", "filename": "paper.pdf"}},
            ]
            config = {"vault": vault, "local_state_dir": root / "local"}
            with mock.patch.object(S, "SCRIPT_DIR", root), mock.patch.object(S, "resolve_collection", return_value="ROOT"), \
                 mock.patch.object(S, "collection_tree", return_value=paths), mock.patch.object(S, "collection_items", return_value=items), \
                 mock.patch.object(S, "source_path_for_attachment", return_value=source), mock.patch.object(S, "api_get", return_value=b"bibtex") as bib, \
                 mock.patch.dict(sys.modules, {"run_pipeline": P}), mock.patch.object(P, "load_config", return_value=config):
                self.assertEqual(S.sync(config_path, organize_only=True), 0)
                self.assertIn("itemKey=PARENT", bib.call_args.args[1])
            task = P.load_queue(config)["items"][0]
            self.assertEqual(task["status"], "awaiting_generation")
            self.assertIn("/DEA/", task["source_path"])
            self.assertIn("/DEA/", task["note_path"])
            self.assertFalse((vault / task["note_path"]).exists())
            P.scan_sources(config)
            self.assertEqual(P.load_queue(config)["items"][0]["status"], "awaiting_generation")

    def test_forge_assets_allow_only_the_exact_paper_image_directory(self):
        scripts = ROOT / "skills/forge-paper-note/scripts"
        with mock.patch.object(sys, "path", [str(scripts), *sys.path]):
            common = module("collection_forge_common", "skills/forge-paper-note/scripts/common.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note = root / "wiki/papers/DEA/deeper/Paper.md"
            expected = root / "wiki/papers/images/Paper"
            self.assertEqual(common.resolve_note_asset_dir(note, "../../images/Paper").resolve(), expected.resolve())
            for value in ("../../images/Other", "../../../outside", str(expected)):
                with self.assertRaises(RuntimeError):
                    common.resolve_note_asset_dir(note, value)

    def fixture(self, vault):
        config = {"vault": vault, "local_state_dir": vault / "local"}
        old_pdf = "sources/literature/pdf/paper.pdf"
        new_pdf = "sources/literature/pdf/DEA/paper.pdf"
        for relative in (old_pdf, new_pdf):
            path = vault / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"original PDF")
        digest = P.file_sha256(vault / old_pdf)
        old_note = "wiki/papers/2026-09-01 - A - Paper.md"
        task = {"id": f"paper:OLD:{digest[:16]}", "kind": "paper", "attachment_key": "OLD", "parent_key": "PARENT",
                "doi": "10.1/paper", "sha256": digest, "source_identity": "paper:OLD", "source_path": old_pdf,
                "note_path": old_note, "status": "drafted", "attempts": 3, **P.paper_image_identity(old_note)}
        entry = {"attachment_key": "NEW", "parent_key": "NEW_PARENT", "doi": "10.1/paper", "title": "Paper",
                 "creators": ["A"], "sha256": digest, "destination": new_pdf, "collection_path": "DEA",
                 "collection_paths": ["DEA"], "previous_destinations": [old_pdf], "active": True}
        note = vault / old_note
        note.parent.mkdir(parents=True, exist_ok=True)
        note.write_text(f'---\ntype: paper\nstatus: draft\nsource_id: {task["id"]}\nsource_sha256: {digest}\nsource_pdf: "[[{old_pdf}]]"\nimages_dir: "{task["images_dir"]}"\n---\n# Paper\n[[{old_pdf}#page=3|p. 3]]\n![Figure](images/{note.stem}/fig.png)\n## 人工复核\n- [x] Keep this\n# 提问\nMy own question\n')
        image = vault / task["images_dir"] / "fig.png"
        image.parent.mkdir(parents=True)
        image.write_bytes(b"image")
        (vault / "wiki/index.md").write_text(f"[[{old_note[:-3]}|Paper]]\n")
        reading = vault / P.paper_paragraph_reading_identity(old_note)["paragraph_reading_note_path"]
        reading.parent.mkdir(parents=True)
        reading.write_text(f'---\nsource_note: "[[{old_note}]]"\n---\nHuman answer\n')
        queue = {"schema_version": 1, "items": [task]}
        manifest = {"items": [entry], "collections": {"ROOT": "", "A": "DEA"}}
        P.save_queue(config, queue)
        P.atomic_write_json(vault / "sources/literature/manifests/zotero-doc.json", manifest)
        return config, queue, manifest, old_note, old_pdf, new_pdf

    def test_scan_moves_note_references_and_reuses_reimported_source_without_requeue(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            config, queue, manifest, old_note, old_pdf, new_pdf = self.fixture(vault)
            P.record_admission(config, queue["items"][0])
            self.assertEqual(P.scan_sources(config, defer_new=True), 0)
            task = P.load_queue(config)["items"][0]
            self.assertEqual(task["status"], "drafted")
            self.assertEqual(task["attempts"], 3)
            self.assertEqual(task["attachment_key"], "NEW")
            self.assertEqual(task["source_path"], new_pdf)
            self.assertIn("wiki/papers/DEA/", task["note_path"])
            self.assertFalse((vault / old_note).exists())
            self.assertFalse((vault / old_pdf).exists())
            text = (vault / task["note_path"]).read_text()
            self.assertIn("# 提问\nMy own question", text)
            self.assertIn("- [x] Keep this", text)
            self.assertIn(f"[[{new_pdf}#page=3|p. 3]]", text)
            self.assertIn("](../images/", text)
            P.validate_paper_image_contract(config, task, text)
            self.assertIn(task["note_path"][:-3], (vault / "wiki/index.md").read_text())
            reading = P.paper_paragraph_reading_identity(task["note_path"])["paragraph_reading_note_path"]
            self.assertEqual(P.resolve_primary_paper_note(config, reading)[1], task["note_path"])
            receipt = P.read_json(P.local_pipeline_dir(config) / "admissions.json", {})[task["id"]]
            self.assertEqual(receipt["note_path"], task["note_path"])
            before = P.load_queue(config)
            self.assertEqual(P.scan_sources(config), 0)
            self.assertEqual(P.load_queue(config), before)

    def test_new_sources_stay_held_on_subsequent_automatic_scans(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            config, queue, manifest, *_ = self.fixture(vault)
            other_pdf = vault / "sources/literature/pdf/DEA/other.pdf"
            other_pdf.write_bytes(b"different PDF")
            extra = {**manifest["items"][0], "attachment_key": "OTHER", "doi": "10.1/new", "generation_deferred": True,
                     "previous_destinations": [], "title": "Another paper", "destination": other_pdf.relative_to(vault).as_posix(),
                     "sha256": P.file_sha256(other_pdf)}
            manifest["items"].append(extra)
            P.atomic_write_json(vault / "sources/literature/manifests/zotero-doc.json", manifest)
            self.assertEqual(P.scan_sources(config), 1)
            self.assertEqual(P.scan_sources(config), 0)
            self.assertEqual([t["status"] for t in P.load_queue(config)["items"]], ["drafted", "awaiting_generation"])

    def test_destination_conflict_preserves_source_note_and_queue(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            config, queue, manifest, old_note, old_pdf, _ = self.fixture(vault)
            destination = vault / "wiki/papers/DEA" / Path(old_note).name
            destination.parent.mkdir()
            destination.write_text("User-authored conflict")
            before = (vault / old_note).read_bytes()
            with self.assertRaisesRegex(RuntimeError, "conflicts"):
                P.scan_sources(config)
            self.assertEqual((vault / old_note).read_bytes(), before)
            self.assertEqual(destination.read_text(), "User-authored conflict")
            self.assertTrue((vault / old_pdf).exists())

    def test_nested_note_recovery_excludes_reading_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            config, queue, manifest, *_ = self.fixture(vault)
            P.scan_sources(config)
            candidate = P.paper_task(manifest["items"][0], vault)
            self.assertTrue(P.recover_existing_note(vault, candidate))
            self.assertEqual(candidate["status"], "drafted")
            self.assertIn("/DEA/", candidate["note_path"])
            for value in ["wiki/papers/close-reading/log.md", "wiki/papers/images/note.md", "wiki/papers/../other.md"]:
                self.assertFalse(P.is_primary_paper_path(Path(value)))

    def test_failed_candidate_and_plan_follow_folder_without_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            config, queue, manifest, old_note, *_ = self.fixture(vault)
            task = queue["items"][0]
            task.update(status="failed", forge_runtime_dir="system/runtime/forge/task/run")
            candidate = vault / task["forge_runtime_dir"] / "workspace" / old_note
            candidate.parent.mkdir(parents=True)
            candidate.write_bytes((vault / old_note).read_bytes())
            (vault / old_note).unlink()
            task["forge_candidate_path"] = candidate.relative_to(vault).as_posix()
            P.save_queue(config, queue)
            P.scan_sources(config)
            updated = P.load_queue(config)["items"][0]
            self.assertEqual(updated["status"], "failed")
            self.assertEqual(updated["attempts"], 3)
            self.assertFalse(candidate.exists())
            self.assertTrue((vault / updated["forge_candidate_path"]).exists())
            self.assertIn("](../images/", (vault / updated["forge_candidate_path"]).read_text())


if __name__ == "__main__":
    unittest.main()

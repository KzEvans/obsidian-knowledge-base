import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1] / "knowledge-base/system/zotero-sync"
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("sync_enrichment", ROOT / "sync_zotero_doc.py")
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)


class SyncEnrichmentTest(unittest.TestCase):
    def run_fixture(self, enrich):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vault = root / "vault"
            vault.mkdir()
            source = root / "paper.pdf"
            source.write_bytes(b"%PDF-test")
            config = root / "config.json"
            config.write_text(json.dumps({"api_base": "http://localhost:23119/api", "collection_name": "Fixture", "collection_key": "COLLECTION", "vault_path": str(vault), "literature_dir": "sources/literature"}))
            items = [{"key": "PARENT", "data": {"itemType": "journalArticle", "title": "Paper", "publicationTitle": "Journal", "creators": []}}, {"key": "ATTACH", "data": {"itemType": "attachment", "contentType": "application/pdf", "parentItem": "PARENT", "filename": "paper.pdf"}}]
            with mock.patch.object(S, "SCRIPT_DIR", root), mock.patch.object(S, "resolve_collection", return_value="COLLECTION"), mock.patch.object(S, "api_json", return_value=items), mock.patch.object(S, "api_get", return_value=b"bibliography"), mock.patch.object(S, "source_path_for_attachment", return_value=source), mock.patch.object(S, "scan_knowledge_queue") as scan, mock.patch.object(S, "refresh_automatic_impact_factors", return_value=({}, True)) as metrics, mock.patch.object(S, "sync_supporting_information", return_value=({"items": []}, False, {})) as si:
                self.assertEqual(S._sync(config, enrich=enrich), 0)
            if enrich:
                metrics.assert_called_once()
                si.assert_called_once()
                scan.assert_not_called()
                self.assertFalse((root / "state.json").exists())
                self.assertFalse((vault / "sources/literature/pdf").exists())
            else:
                metrics.assert_not_called()
                si.assert_not_called()
                scan.assert_called_once()
                self.assertTrue((vault / "sources/literature/manifests/zotero-doc.json").exists())

    def test_primary_sync_never_waits_for_network_enrichment(self):
        self.run_fixture(False)

    def test_enrichment_writes_only_auxiliary_state(self):
        self.run_fixture(True)


if __name__ == "__main__":
    unittest.main()

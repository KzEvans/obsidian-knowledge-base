"""Selected pipeline figures require no device-local configuration admission."""
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


SCRIPTS = Path(__file__).resolve().parents[1] / "skills/forge-paper-note/scripts"
with mock.patch.object(sys, "path", [str(SCRIPTS), *sys.path]):
    spec = importlib.util.spec_from_file_location("materialize_pipeline", SCRIPTS / "materialize_figure_asset.py")
    M = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(M)


class MaterializePipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.vault = self.root / "workspace"
        self.vault.mkdir()
        self.source = self.root / "fig-01.png"
        self.source.write_bytes(b"selected image bytes")
        self.stem = "2026-10-12 - Author - Paper"

    def command(self, collection, asset_subdir):
        return [
            "materialize_figure_asset.py", "--source-image", str(self.source),
            "--title", "Paper", "--vault", str(self.vault),
            "--save-mode", "obsidian", "--papers-dir", "wiki/papers",
            "--subdir", collection, "--filename", self.stem + ".md",
            "--asset-subdir", asset_subdir,
        ]

    def materialize(self, collection, asset_subdir):
        output = io.StringIO()
        with mock.patch.object(sys, "argv", self.command(collection, asset_subdir)), \
             mock.patch.object(M, "runtime_config", side_effect=AssertionError("Must not inspect device configuration")), \
             mock.patch.object(sys, "stdout", output):
            M.main()
        return json.loads(output.getvalue())

    def test_classified_pipeline_uses_exact_flat_note_and_image_paths_without_preferences(self):
        payload = self.materialize("自适应聚合物网络", "../images/" + self.stem)
        expected_note = self.vault / "wiki/papers/自适应聚合物网络" / (self.stem + ".md")
        expected_image = self.vault / "wiki/papers/images" / self.stem / self.source.name
        self.assertEqual(Path(payload["note_path"]), expected_note)
        self.assertEqual(Path(payload["dest_image_path"]), expected_image)
        self.assertEqual(expected_image.read_bytes(), self.source.read_bytes())
        self.assertEqual(payload["obsidian_embed"], f"![[wiki/papers/images/{self.stem}/{self.source.name}]]")
        self.assertFalse(expected_note.exists(), "The figure helper must not create the note")

    def test_root_pipeline_and_nested_collections_keep_one_shared_exact_image_directory(self):
        for collection, asset_subdir in (("wiki/papers", "images/" + self.stem), ("DEA/subtopic", "../../images/" + self.stem)):
            with self.subTest(collection=collection):
                payload = self.materialize(collection, asset_subdir)
                self.assertEqual(Path(payload["dest_image_path"]), self.vault / "wiki/papers/images" / self.stem / self.source.name)

    def test_pipeline_asset_traversal_and_other_paper_directory_remain_rejected(self):
        for asset in ("../../../outside", "../images/Other paper"):
            with self.subTest(asset=asset), self.assertRaisesRegex(RuntimeError, "Unsafe asset_subdir"):
                self.materialize("自适应聚合物网络", asset)
        self.assertFalse((self.root / "outside").exists())

    def test_explicit_self_managed_destination_retains_its_original_per_paper_folder(self):
        args = M.parser().parse_args([
            "--source-image", str(self.source), "--title", "Paper",
            "--vault", str(self.vault), "--papers-dir", "Research/Papers",
        ])
        with mock.patch.object(M, "runtime_config", side_effect=AssertionError("Explicit image target needs no language")):
            config = M.asset_config(args)
        actual = M.materialize_note_path(config, args, "Paper", "Polymers")
        self.assertEqual(actual, self.vault / "Research/Papers/Polymers/Paper/Paper.md")

    def test_self_managed_fallback_still_uses_runtime_preferences(self):
        args = M.parser().parse_args(["--source-image", str(self.source), "--title", "Paper"])
        configured = {"save_mode": "workspace", "workspace_output_dir": "existing-output"}
        with mock.patch.object(M, "runtime_config", return_value=configured) as resolve:
            self.assertIs(M.asset_config(args), configured)
        resolve.assert_called_once_with(cli_overrides={"save_mode": "", "obsidian_vault": "", "papers_dir": ""})

    def test_explicit_relative_vault_is_rejected(self):
        args = M.parser().parse_args([
            "--source-image", str(self.source), "--title", "Paper",
            "--vault", "relative-vault", "--papers-dir", "wiki/papers",
        ])
        with self.assertRaisesRegex(RuntimeError, "absolute path"):
            M.asset_config(args)


if __name__ == "__main__":
    unittest.main()

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY = Path(__file__).resolve().parents[1]
SCRIPT_DIR = REPOSITORY / "skills" / "forge-paper-note" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import lint_note  # noqa: E402
import normalize_markdown_tables as TABLES  # noqa: E402


class ForgeMarkdownTableTest(unittest.TestCase):
    def test_normalizer_escapes_wikilinks_compacts_aliases_and_removes_empty_columns(self):
        source = (
            "| 工作 | 结论 | 证据 |  |\n"
            "| --- | --- | --- | --- |\n"
            "| Ref. 1 | Result | "
            "[[sources/paper.pdf#page=3 | PDF p.3]] |  |\n"
        )
        normalized, report = TABLES.normalize_markdown_tables(source)
        self.assertEqual(report["wikilinks_fixed"], 1)
        self.assertEqual(report["empty_columns_removed"], 1)
        self.assertIn("[[sources/paper.pdf#page=3\\|p.3]]", normalized)
        self.assertNotIn("|  |", normalized)
        second_pass, second_report = TABLES.normalize_markdown_tables(normalized)
        self.assertEqual(second_pass, normalized)
        self.assertFalse(second_report["changed"])

    def test_table_lint_rejects_unescaped_links_and_plain_reference_numbers(self):
        lint_note.configure_output_language("zh-CN", "pipeline-paperforge")
        source = (
            "## 2. 前人工作与不足\n\n"
            "| 工作 | 结论 | 证据 |\n"
            "| --- | --- | --- |\n"
            "| Suo (2010) [15] | Result | [[sources/paper.pdf#page=3|PDF p.3]] |\n"
        )
        reasons = {item["reason"] for item in lint_note.inspect_table_hygiene(source)}
        self.assertIn("table_wikilink_pipe_unescaped", reasons)
        self.assertIn("table_reference_not_linked", reasons)

    def test_compact_clickable_reference_table_passes(self):
        lint_note.configure_output_language("zh-CN", "pipeline-paperforge")
        source = (
            "## 2. 前人工作与不足\n\n"
            "仅依据本文转述，未独立核验。\n\n"
            "| 工作 | 结论 | 证据 |\n"
            "| --- | --- | --- |\n"
            "| [[sources/paper.pdf#page=8\\|Ref. 15]] · Suo (2010) | Result | "
            "[[sources/paper.pdf#page=3\\|p.3]] |\n"
        )
        self.assertEqual(lint_note.inspect_table_hygiene(source), [])

    def test_pipeline_profile_accepts_numbered_top_level_contract_without_save_config(self):
        headings = lint_note.PIPELINE_PAPERFORGE_SECTIONS["zh-CN"]
        note = "---\nstatus: draft\n---\n\n# Paper\n\n" + "\n\n".join(
            f"## {heading}\n\nPaper-specific content with 42 units and evidence."
            for heading in headings
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "note.md"
            output = Path(directory) / "lint.json"
            path.write_text(note, encoding="utf-8")
            env = os.environ.copy()
            env.pop("DEEPPAPERNOTE_SAVE_MODE", None)
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_DIR / "lint_note.py"),
                    "--input",
                    str(path),
                    "--language",
                    "zh-CN",
                    "--profile",
                    "pipeline-paperforge",
                    "--output",
                    str(output),
                ],
                capture_output=True,
                text=True,
                env=env,
                timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = __import__("json").loads(output.read_text(encoding="utf-8"))
            self.assertEqual(payload["missing_sections"], [])
            self.assertEqual(payload["profile"], "pipeline-paperforge")


if __name__ == "__main__":
    unittest.main()

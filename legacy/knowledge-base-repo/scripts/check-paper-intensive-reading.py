#!/usr/bin/env python3
"""Validate the device-local paragraph-pair Mode A intensive-reading skill."""

from __future__ import annotations

import os
from pathlib import Path


def main() -> int:
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
    skill_file = codex_home / "skills" / "paper-intensive-reading" / "SKILL.md"
    workflow_file = skill_file.parent / "references" / "workflow.md"
    crop_script = skill_file.parent / "scripts" / "crop_pdf_region.py"
    if not skill_file.is_file() or not workflow_file.is_file() or not crop_script.is_file():
        print(f"paper-intensive-reading skill is incomplete: {skill_file.parent}")
        return 1
    combined = skill_file.read_text(encoding="utf-8", errors="ignore") + workflow_file.read_text(
        encoding="utf-8", errors="ignore"
    )
    required = (
        "Mode A",
        "full-text",
        "ready_to_merge",
        "MinerU",
        "verified-unit",
        "intensive-reading",
        "submit-initial",
        "full-text-unlabeled-paragraph-pairs",
        "crop_pdf_region.py",
    )
    missing = [marker for marker in required if marker not in combined]
    if missing:
        print(f"paper-intensive-reading is missing markers: {', '.join(missing)}")
        return 2
    print(f"paper-intensive-reading ready: {skill_file.parent}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

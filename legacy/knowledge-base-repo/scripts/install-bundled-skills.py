#!/usr/bin/env python3
"""Install the knowledge pipeline's bundled Codex skills without overwriting copies."""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path


SKILLS = ("forge-paper-note", "paper-reading", "paper-intensive-reading")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--destination",
        type=Path,
        default=None,
        help="Codex skills directory (default: $CODEX_HOME/skills or ~/.codex/skills)",
    )
    args = parser.parse_args()

    repository_root = Path(__file__).resolve().parents[1]
    source_root = repository_root / "skills"
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
    destination_root = (args.destination or codex_home / "skills").expanduser()

    missing = [name for name in SKILLS if not (source_root / name / "SKILL.md").is_file()]
    if missing:
        print(f"Bundled skills are incomplete: {', '.join(missing)}")
        return 1

    conflicts = [name for name in SKILLS if (destination_root / name).exists()]
    if conflicts:
        print("Installation stopped; existing skill directories were not overwritten:")
        for name in conflicts:
            print(f"- {destination_root / name}")
        print("Rename or remove those exact directories, then run this installer again.")
        return 2

    destination_root.mkdir(parents=True, exist_ok=True)
    for name in SKILLS:
        destination = destination_root / name
        shutil.copytree(
            source_root / name,
            destination,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"),
        )
        print(f"Installed {name}: {destination}")
    print("Start a new Codex task so the bundled skills are discovered.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

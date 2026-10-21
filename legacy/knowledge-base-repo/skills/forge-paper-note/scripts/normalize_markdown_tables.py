#!/usr/bin/env python3
"""Normalize Obsidian wikilinks and remove structurally empty Markdown table columns."""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any


WIKILINK_RE = re.compile(r"(!?\[\[)(.*?)(\]\])")
DELIMITER_CELL_RE = re.compile(r"^:?-{3,}:?$")


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def normalize_table_wikilinks(line: str) -> tuple[str, int]:
    changes = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal changes
        content = match.group(2)
        separator = re.search(r"(?<!\\)\|", content)
        if not separator:
            return match.group(0)
        target = content[: separator.start()].strip()
        alias = content[separator.end() :].strip()
        page = re.search(r"#page=(\d+)\s*$", target, flags=re.IGNORECASE)
        if page and re.fullmatch(r"(?:PDF\s+)?p\.\s*\d+", alias, flags=re.IGNORECASE):
            alias = f"p.{page.group(1)}"
        elif page and re.fullmatch(r"SI\s+p\.\s*\d+", alias, flags=re.IGNORECASE):
            alias = f"SI p.{page.group(1)}"
        normalized = f"{match.group(1)}{target}\\|{alias}{match.group(3)}"
        if normalized != match.group(0):
            changes += 1
        return normalized

    return WIKILINK_RE.sub(replace, line), changes


def split_row(line: str) -> list[str]:
    stripped = line.strip()
    if stripped.startswith("|"):
        stripped = stripped[1:]
    if stripped.endswith("|") and not stripped.endswith(r"\|"):
        stripped = stripped[:-1]
    return [cell.strip() for cell in re.split(r"(?<!\\)\|", stripped)]


def is_delimiter_row(line: str) -> bool:
    cells = split_row(line)
    return bool(cells) and all(DELIMITER_CELL_RE.fullmatch(cell) for cell in cells)


def render_row(cells: list[str]) -> str:
    return "| " + " | ".join(cells) + " |"


def table_blocks(lines: list[str]) -> list[tuple[int, int]]:
    blocks: list[tuple[int, int]] = []
    index = 0
    while index + 1 < len(lines):
        if "|" not in lines[index] or not is_delimiter_row(lines[index + 1]):
            index += 1
            continue
        end = index + 2
        while end < len(lines) and "|" in lines[end] and lines[end].strip():
            end += 1
        blocks.append((index, end))
        index = end
    return blocks


def normalize_markdown_tables(text: str) -> tuple[str, dict[str, Any]]:
    lines = text.splitlines()
    trailing_newline = text.endswith("\n")
    wikilinks_fixed = 0
    empty_columns_removed = 0
    normalized_tables = 0

    for start, end in reversed(table_blocks(lines)):
        block: list[list[str]] = []
        for line in lines[start:end]:
            normalized, changes = normalize_table_wikilinks(line)
            wikilinks_fixed += changes
            block.append(split_row(normalized))

        width = max(len(row) for row in block)
        padded = [row + [""] * (width - len(row)) for row in block]
        content_rows = padded[2:] or padded[:1]
        keep = [
            column
            for column in range(width)
            if any(row[column].strip() for row in content_rows)
        ]
        if not keep:
            keep = list(range(width))
        empty_columns_removed += width - len(keep)
        rebuilt = []
        for row_index, row in enumerate(padded):
            selected = [row[column].strip() for column in keep]
            if row_index == 1:
                selected = [cell if DELIMITER_CELL_RE.fullmatch(cell) else "---" for cell in selected]
            rebuilt.append(render_row(selected))
        if rebuilt != lines[start:end]:
            normalized_tables += 1
            lines[start:end] = rebuilt

    normalized_text = "\n".join(lines) + ("\n" if trailing_newline else "")
    return normalized_text, {
        "tables_seen": len(table_blocks(text.splitlines())),
        "tables_normalized": normalized_tables,
        "wikilinks_fixed": wikilinks_fixed,
        "empty_columns_removed": empty_columns_removed,
        "changed": normalized_text != text,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Markdown note path")
    parser.add_argument("--write", action="store_true", help="Atomically update the input note")
    parser.add_argument("--output", default="", help="Optional JSON report path")
    args = parser.parse_args()

    path = Path(args.input).expanduser().resolve()
    original = path.read_text(encoding="utf-8-sig")
    normalized, report = normalize_markdown_tables(original)
    report["input"] = str(path)
    if args.write and normalized != original:
        atomic_write_text(path, normalized)
    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        atomic_write_text(Path(args.output).expanduser().resolve(), serialized)
    print(serialized, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

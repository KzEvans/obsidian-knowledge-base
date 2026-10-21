#!/usr/bin/env python3
"""Copy a chosen figure candidate into the Obsidian vault and return embed markup."""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path

from common import (
    emit,
    maybe_load_json_record,
    require_path_within,
    resolve_domain_subdir,
    resolve_note_asset_dir,
    resolve_note_output_mode,
    resolve_obsidian_note_path,
    runtime_config,
    safe_relative_path_parts,
)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__ or "materialize figure asset")
    p.add_argument("--source-image", required=True, help="Source image path selected by the model.")
    p.add_argument("--input", default="", help="Optional metadata JSON path or JSON string.")
    p.add_argument("--title", default="", help="Explicit paper title.")
    p.add_argument("--vault", default="", help="Target Obsidian vault path.")
    p.add_argument("--save-mode", choices=("workspace", "obsidian"), default="")
    p.add_argument("--papers-dir", default="", help="Vault-relative paper directory.")
    p.add_argument("--subdir", default="", help="Vault-relative note subdirectory.")
    p.add_argument("--filename", default="", help="Optional note filename override.")
    p.add_argument("--asset-subdir", default="images", help="Asset folder name relative to the note directory.")
    p.add_argument("--label", default="", help="Optional human-readable label for the figure.")
    p.add_argument("--output", default="", help="JSON output path.")
    return p


def asset_config(args: argparse.Namespace) -> dict:
    if args.vault and args.papers_dir and args.save_mode in ("", "obsidian"):
        # Copying a selected image needs a destination, not a prose language.
        # Explicit pipeline destinations must not consult device preferences.
        vault = Path(args.vault).expanduser()
        if not vault.is_absolute():
            raise RuntimeError("Target Obsidian vault must be an absolute path.")
        return {"save_mode": "obsidian", "obsidian_vault": str(vault), "papers_dir": args.papers_dir}
    return runtime_config(
        cli_overrides={
            "save_mode": args.save_mode or ("obsidian" if args.vault else ""),
            "obsidian_vault": args.vault,
            "papers_dir": args.papers_dir,
        }
    )


def materialize_note_path(config: dict, args: argparse.Namespace, title: str, subdir: str) -> Path:
    output_mode, root = resolve_note_output_mode(config)
    papers = safe_relative_path_parts(config.get("papers_dir", ""), "papers_dir")
    filename = safe_relative_path_parts(args.filename, "filename")
    if output_mode == "obsidian" and papers == ("wiki", "papers") and len(filename) == 1:
        # Pipeline notes are flat within their collection. Recognize only the
        # exact shared per-paper image directory, retaining all path checks.
        collection = safe_relative_path_parts(subdir, "subdir")
        relative_dir = collection if collection[:len(papers)] == papers else (*papers, *collection)
        note = require_path_within(root / Path(*papers), root / Path(*relative_dir) / filename[0], "note path")
        expected = root / Path(*papers) / "images" / note.stem
        if not Path(args.asset_subdir).is_absolute() and (note.parent / args.asset_subdir).resolve() == expected.resolve():
            return note
    return resolve_obsidian_note_path(config, title=title, subdir=subdir, filename=args.filename)


def main() -> None:
    args = parser().parse_args()
    record = maybe_load_json_record(args.input) or {}
    title = args.title or str(record.get("title", "")).strip()
    if not title:
        raise SystemExit("materialize_figure_asset.py requires --title or metadata with a title.")

    config = asset_config(args)
    resolved_subdir = resolve_domain_subdir(
        config,
        title=title,
        abstract=str(record.get("abstract", "")),
        subdir=args.subdir,
    )

    note_path = materialize_note_path(config, args, title, resolved_subdir)
    source_image = Path(args.source_image).expanduser().resolve()
    if not source_image.exists():
        raise SystemExit(f"Source image does not exist: {source_image}")

    asset_dir = resolve_note_asset_dir(note_path, args.asset_subdir)
    asset_dir.mkdir(parents=True, exist_ok=True)
    dest_image = require_path_within(asset_dir, asset_dir / source_image.name, "asset path")
    shutil.copy2(source_image, dest_image)

    output_mode, root_root = resolve_note_output_mode(config)
    relative_from_note = Path(os.path.relpath(dest_image, note_path.parent))
    relative_markdown_embed = f"![{args.label or source_image.stem}]({relative_from_note.as_posix()})"
    # as_posix() keeps forward slashes; str(Path) would emit backslashes on
    # Windows, producing a broken Markdown image link.
    absolute_markdown_embed = f"![{args.label or source_image.stem}]({dest_image.as_posix()})"

    payload = {
        "status": "ok",
        "script": "materialize_figure_asset.py",
        "title": title,
        "note_path": str(note_path),
        "source_image": str(source_image),
        "dest_image_path": str(dest_image),
        "absolute_markdown_embed": absolute_markdown_embed,
        "relative_markdown_embed": relative_markdown_embed,
        "label": args.label,
        "output_mode": output_mode,
        "subdir": resolved_subdir,
    }

    if output_mode == "obsidian":
        vault_relative = dest_image.relative_to(root_root)
        payload["vault_relative_image_path"] = vault_relative.as_posix()
        payload["obsidian_embed"] = f"![[{vault_relative.as_posix()}]]"
    emit(payload, args.output)


if __name__ == "__main__":
    main()

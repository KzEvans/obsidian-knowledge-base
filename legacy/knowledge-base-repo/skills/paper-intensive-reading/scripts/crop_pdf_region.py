#!/usr/bin/env python3
"""Render one rectangular region directly from a PDF page into a PNG."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Sequence


def parse_bbox(value: str) -> tuple[int, int, int, int]:
    try:
        parts = tuple(int(part.strip()) for part in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("bbox must contain four integers") from error
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("bbox must be left,top,width,height")
    left, top, width, height = parts
    if left < 0 or top < 0 or width < 1 or height < 1:
        raise argparse.ArgumentTypeError("bbox coordinates must be non-negative with positive size")
    return left, top, width, height


def path_inside(path: Path, root: Path) -> Path:
    resolved = path.expanduser().resolve()
    try:
        resolved.relative_to(root.expanduser().resolve())
    except ValueError as error:
        raise RuntimeError(f"Output must stay inside allowed root: {root}") from error
    return resolved


def crop_pdf_region(argv: Sequence[str] | None = None) -> dict[str, object]:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--page", required=True, type=int)
    parser.add_argument("--bbox", required=True, type=parse_bbox)
    parser.add_argument("--dpi", type=int, default=180)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--allowed-root", required=True, type=Path)
    args = parser.parse_args(argv)

    source = args.pdf.expanduser().resolve()
    if not source.is_file() or source.suffix.casefold() != ".pdf":
        raise RuntimeError(f"Source is not a PDF file: {source}")
    if args.page < 1:
        raise RuntimeError("Page number must be at least 1")
    if args.dpi < 72 or args.dpi > 600:
        raise RuntimeError("DPI must be between 72 and 600")
    if shutil.which("pdftoppm") is None:
        raise RuntimeError("pdftoppm is required to crop directly from the PDF")

    allowed_root = args.allowed_root.expanduser().resolve()
    allowed_root.mkdir(parents=True, exist_ok=True)
    output = path_inside(args.output, allowed_root)
    if output.suffix.casefold() != ".png":
        raise RuntimeError("Output must use the .png extension")
    output.parent.mkdir(parents=True, exist_ok=True)

    left, top, width, height = args.bbox
    with tempfile.TemporaryDirectory(prefix=".pdf-crop-", dir=str(output.parent)) as temp_dir:
        prefix = Path(temp_dir) / "crop"
        command = [
            "pdftoppm",
            "-f",
            str(args.page),
            "-l",
            str(args.page),
            "-r",
            str(args.dpi),
            "-x",
            str(left),
            "-y",
            str(top),
            "-W",
            str(width),
            "-H",
            str(height),
            "-singlefile",
            "-png",
            str(source),
            str(prefix),
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=120)
        rendered = prefix.with_suffix(".png")
        if result.returncode != 0 or not rendered.is_file():
            detail = result.stderr.strip() or result.stdout.strip() or "pdftoppm produced no image"
            raise RuntimeError(detail)
        os.replace(rendered, output)

    return {
        "source_pdf": str(source),
        "page": args.page,
        "bbox": [left, top, width, height],
        "dpi": args.dpi,
        "output": str(output),
    }


def main() -> int:
    try:
        print(json.dumps(crop_pdf_region(), ensure_ascii=False, sort_keys=True))
        return 0
    except (RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=__import__("sys").stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

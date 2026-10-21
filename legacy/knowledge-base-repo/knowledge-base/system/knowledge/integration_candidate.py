"""Stage reviewed-note integration and publish only checked canonical changes.

This module deliberately does not approve notes, update their lifecycle, or
maintain the index. Those operations belong to the calling pipeline runner.
"""
from __future__ import annotations

import ast
import json
import os
from pathlib import Path, PurePosixPath
import re
import tempfile
from typing import Any, Dict, Iterable, List, Tuple


CANONICAL_DIRECTORIES = frozenset({
    "concepts", "materials", "methods", "phenomena", "projects", "questions",
    "synthesis",
})
INSTRUCTION_PATHS = (
    "AGENTS.md", "system/workflows/integrate.md",
    "system/knowledge/result.schema.json",
)
_CLAIM = re.compile(r"<!--\s*kb-claim:([A-Za-z0-9][A-Za-z0-9_.:-]*)\s*-->")
_WIKILINK = re.compile(r"!?\[\[([^\]]+)\]\]")
_MARKDOWN_LINK = re.compile(r"(?<!!)\[[^\]]*\]\((<[^>]+>|[^)]+)\)")
_FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", re.S)


def _relative(value: str) -> str:
    path = PurePosixPath(str(value))
    if (not str(value) or "\\" in str(value) or path.is_absolute()
            or any(part in {"", ".", ".."} for part in str(value).split("/"))):
        raise RuntimeError(f"integration_invalid_path: {value}")
    return path.as_posix()


def _canonical(path: str) -> bool:
    parts = PurePosixPath(path).parts
    return (len(parts) >= 3 and parts[0] == "wiki"
            and parts[1] in CANONICAL_DIRECTORIES and parts[-1].endswith(".md"))


def _source_note(path: str) -> bool:
    parts = PurePosixPath(path).parts
    return (len(parts) >= 3 and parts[:2] in {
        ("wiki", "papers"), ("wiki", "experiments"),
    } and path.endswith(".md") and not {"images", "close-reading"}.intersection(parts))


def _text(data: bytes) -> str:
    return data.decode("utf-8-sig")


def _targets(text: str) -> set[str]:
    targets = set()
    for match in _WIKILINK.finditer(text):
        targets.add(re.split(r"\\?\|", match.group(1), maxsplit=1)[0].strip())
    for match in _MARKDOWN_LINK.finditer(text):
        target = match.group(1).strip()
        if target.startswith("<") and target.endswith(">"):
            target = target[1:-1]
        targets.add(target)
    return targets


def _source_targets(text: str) -> set[str]:
    prefixes = ("sources/", "extracts/", "wiki/papers/", "wiki/experiments/",
                "笔记/实验笔记/", "http://", "https://")
    return {target for target in _targets(text) if target.startswith(prefixes)}


def _frontmatter(text: str) -> Dict[str, Tuple[str, List[str]]]:
    """Read relevant scalar/list fields without introducing a YAML dependency."""
    match = _FRONTMATTER.match(text)
    if not match:
        return {}
    fields: Dict[str, Tuple[str, List[str]]] = {}
    current = ""
    for line in match.group(1).splitlines():
        field = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$", line)
        if field:
            current, value = field.groups()
            if current in fields:
                raise RuntimeError(f"integration_metadata_duplicate: {current}")
            fields[current] = (value, [])
        elif current and line.strip() and not line.lstrip().startswith("#"):
            fields[current][1].append(line)
    return fields


def _scalar(value: str) -> str:
    value = value.strip()
    if value.startswith('"'):
        try:
            result = json.loads(value)
        except (ValueError, TypeError):
            raise RuntimeError("integration_metadata_unknown_scalar")
        if not isinstance(result, str):
            raise RuntimeError("integration_metadata_unknown_scalar")
        return result
    if value.startswith("'"):
        if not value.endswith("'") or len(value) < 2:
            raise RuntimeError("integration_metadata_unknown_scalar")
        return value[1:-1].replace("''", "'")
    if not value or any(char in value for char in "[]{}&*!\n"):
        raise RuntimeError("integration_metadata_unknown_scalar")
    return value


def _list(fields: Dict[str, Tuple[str, List[str]]], key: str) -> List[str]:
    if key not in fields:
        return []
    value, lines = fields[key]
    value = value.strip()
    if value in {"null", "~"} and not lines:
        return []
    if key == "aliases" and value and not value.startswith("[") and not lines:
        return [_scalar(value)]
    if not value:
        items = []
        for line in lines:
            match = re.match(r"^\s+-[ \t]+(.+?)\s*$", line)
            if not match:
                raise RuntimeError(f"integration_metadata_unknown_list: {key}")
            items.append(_scalar(match.group(1)))
        return items
    if not value.startswith("[") or not value.endswith("]") or lines:
        raise RuntimeError(f"integration_metadata_unknown_list: {key}")
    # Quoted arrays are JSON or Python-literal compatible. Bare YAML arrays use
    # a small quote-aware splitter, rejecting nested/ambiguous structures.
    try:
        parsed = json.loads(value)
    except ValueError:
        try:
            parsed = ast.literal_eval(value)
        except (ValueError, SyntaxError):
            parsed = None
    if isinstance(parsed, list) and all(isinstance(item, str) for item in parsed):
        return parsed
    if parsed is not None:
        raise RuntimeError(f"integration_metadata_unknown_list: {key}")
    body = value[1:-1].strip()
    if not body:
        return []
    items, start, quote = [], 0, ""
    for index, char in enumerate(body):
        if char in "\"'":
            if quote == char:
                quote = ""
            elif not quote:
                quote = char
        elif char == "," and not quote:
            items.append(_scalar(body[start:index]))
            start = index + 1
        elif char in "[]{}" and not quote:
            raise RuntimeError(f"integration_metadata_unknown_list: {key}")
    if quote:
        raise RuntimeError(f"integration_metadata_unknown_list: {key}")
    items.append(_scalar(body[start:]))
    return items


def _preserve_metadata(old: str, new: str, path: str) -> None:
    previous, proposed = _frontmatter(old), _frontmatter(new)
    preserved_scalars = ("type", "title", "created")
    if path.startswith("wiki/questions/"):
        preserved_scalars += ("status", "question_status", "priority")
        if not old:
            for key in ("status", "question_status"):
                if key in proposed and _scalar(proposed[key][0]).casefold() in {"answered", "resolved", "closed", "已回答", "已解决", "已关闭"}:
                    raise RuntimeError(f"integration_question_state_requires_human: {path}:{key}")
    for key in preserved_scalars:
        if key in previous:
            if (key not in proposed or previous[key][1] or proposed[key][1]
                    or _scalar(previous[key][0]) != _scalar(proposed[key][0])):
                raise RuntimeError(f"integration_metadata_changed: {path}:{key}")
    for key in ("sources", "tags", "related", "aliases"):
        before, after = _list(previous, key), _list(proposed, key)
        if not set(before).issubset(after):
            raise RuntimeError(f"integration_provenance_lost: {path}:{key}")


def _human_blocks(text: str) -> List[str]:
    blocks = []
    patterns = (
        r"<!-- user-notes:start -->.*?<!-- user-notes:end -->",
        r"<!-- intensive-reading:([^:]+):start -->.*?<!-- intensive-reading:\1:end -->",
    )
    for pattern in patterns:
        blocks.extend(match.group(0) for match in re.finditer(pattern, text, re.S))
    headings = list(re.finditer(r"(?m)^(#{1,6})\s+(.+?)\s*$", text))
    for index, heading in enumerate(headings):
        if heading.group(2) not in {"人工复核", "Human Review", "提问"}:
            continue
        end = next((item.start() for item in headings[index + 1:]
                    if len(item.group(1)) <= len(heading.group(1))), len(text))
        blocks.append(text[heading.start():end].rstrip())
    return blocks


def _claim_block(text: str, match: re.Match[str]) -> str:
    start = text.rfind("\n\n", 0, match.start()) + 2
    if start == 1:
        start = 0
    end = text.find("\n\n", match.end())
    block = text[start:end if end >= 0 else len(text)]
    line_start = text.rfind("\n", 0, match.start()) + 1
    line_end = text.find("\n", match.end())
    marker_line = text[line_start:line_end if line_end >= 0 else len(text)]
    if marker_line.lstrip().startswith("|"):
        # A marker inside a table row attaches to that row. A standalone
        # marker before a table must also retain the following evidence.
        return marker_line
    if not _CLAIM.sub("", block).strip():
        # Also accept a marker on a separate line immediately before evidence.
        following = text[match.end():].lstrip("\r\n")
        return following.split("\n\n", 1)[0]
    return block


def _note_link_present(text: str, note_path: str, baselines: Dict[str, bytes]) -> bool:
    full = note_path.removesuffix(".md")
    basename = PurePosixPath(full).name
    unique_basename = sum(PurePosixPath(path).name.removesuffix(".md") == basename
                          for path in baselines if path.startswith("wiki/")) == 1
    for target in _targets(text):
        target = target.split("#", 1)[0].removesuffix(".md")
        if target == full or (unique_basename and target == basename):
            return True
    return False


def prepare_integration_candidate(
    vault: Path, runtime: Path, note_path: str,
    *, evidence_note_paths: Iterable[str] = (),
    original_source_paths: Iterable[str] = (),
) -> Tuple[Path, Dict[str, bytes]]:
    vault = Path(vault).resolve()
    note_path = _relative(note_path)
    if not _source_note(note_path) or not (vault / note_path).is_file():
        raise RuntimeError("integration_invalid_source_note")
    workspace = Path(runtime) / "workspace"
    workspace.mkdir(parents=True, exist_ok=False)
    baselines: Dict[str, bytes] = {}

    def copy_input(relative: str) -> None:
        source = vault / relative
        if (source.is_symlink() or not source.is_file()
                or not source.resolve().is_relative_to(vault)):
            raise RuntimeError(f"integration_invalid_input: {relative}")
        data = source.read_bytes()
        baselines[relative] = data
        destination = workspace / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        destination.chmod(0o644 if _canonical(relative) else 0o444)

    for source in sorted((vault / "wiki").rglob("*.md")):
        relative = source.relative_to(vault).as_posix()
        if not {"images", "close-reading"}.intersection(PurePosixPath(relative).parts):
            copy_input(relative)
    for relative in INSTRUCTION_PATHS:
        copy_input(relative)
    for relative in ("system/knowledge/purpose.md", "system/knowledge/concept-aliases.json"):
        if (vault / relative).exists():
            copy_input(relative)
    for name in ("sources", "extracts"):
        if (vault / name).is_dir():
            (workspace / name).symlink_to(vault / name, target_is_directory=True)

    evidence_notes = {note_path, *(_relative(path) for path in evidence_note_paths)}
    if any(not _source_note(path) or path not in baselines for path in evidence_notes):
        raise RuntimeError("integration_invalid_evidence_note")
    source_paths = {target.split("#", 1)[0] for path in evidence_notes
                    for target in _source_targets(_text(baselines[path]))}
    source_paths.update(_relative(path) for path in original_source_paths)
    for raw_path in sorted(source_paths):
        if raw_path.startswith(("http://", "https://", "wiki/")):
            continue
        relative = _relative(raw_path)
        source = vault / relative
        if (source.is_symlink() or not source.is_file()
                or not source.resolve().is_relative_to(vault)):
            raise RuntimeError(f"integration_source_missing: {relative}")
        baselines[relative] = source.read_bytes()
        if not relative.startswith(("sources/", "extracts/")):
            copy_input(relative)
    return workspace, baselines


def _workspace_files(workspace: Path, vault: Path, baselines: Dict[str, bytes]) -> Dict[str, bytes]:
    files: Dict[str, bytes] = {}
    known_directories = {PurePosixPath(path).parent.as_posix() for path in baselines}
    known_directories.update(parent.as_posix() for path in baselines
                             for parent in PurePosixPath(path).parents)
    for root, directories, names in os.walk(workspace, followlinks=False):
        root_path = Path(root)
        for name in list(directories):
            path = root_path / name
            relative = path.relative_to(workspace).as_posix()
            if path.is_symlink():
                if relative not in {"sources", "extracts"} or path.resolve() != (vault / relative).resolve():
                    raise RuntimeError(f"integration_illegal_symlink: {relative}")
                directories.remove(name)
                continue
            parts = PurePosixPath(relative).parts
            allowed = (relative in known_directories
                       or (len(parts) >= 2 and parts[0] == "wiki"
                           and parts[1] in CANONICAL_DIRECTORIES)
                       or relative == "system/runtime" or relative.startswith("system/runtime/"))
            if not allowed:
                raise RuntimeError(f"integration_illegal_directory: {relative}")
        for name in names:
            path = root_path / name
            relative = path.relative_to(workspace).as_posix()
            if path.is_symlink() or not path.is_file():
                raise RuntimeError(f"integration_illegal_file: {relative}")
            if (relative.startswith("system/runtime/")
                    and path.suffix in {".json", ".jsonl", ".log", ".txt"}):
                continue
            files[relative] = path.read_bytes()
    for name in ("sources", "extracts"):
        if (vault / name).is_dir() and not (workspace / name).is_symlink():
            raise RuntimeError(f"integration_source_link_changed: {name}")
    return files


def validate_integration_candidate(
    vault: Path, workspace: Path, baselines: Dict[str, bytes], note_path: str,
    claims: Iterable[Dict[str, Any]],
) -> List[str]:
    vault, workspace = Path(vault).resolve(), Path(workspace).resolve()
    note_path = _relative(note_path)
    if note_path not in baselines or not _source_note(note_path):
        raise RuntimeError("integration_invalid_source_note")
    files = _workspace_files(workspace, vault, baselines)
    for relative, before in baselines.items():
        if relative.startswith(("sources/", "extracts/")):
            if not (vault / relative).is_file() or (vault / relative).read_bytes() != before:
                raise RuntimeError(f"integration_input_changed: {relative}")
            continue
        if relative not in files:
            raise RuntimeError(f"integration_deleted_input: {relative}")
        if not _canonical(relative) and files[relative] != before:
            raise RuntimeError(f"integration_readonly_input_changed: {relative}")
    changed = sorted(path for path, data in files.items() if baselines.get(path) != data)
    if any(not _canonical(path) for path in changed):
        raise RuntimeError("integration_unauthorized_write: " + ", ".join(
            path for path in changed if not _canonical(path)))

    records: Dict[str, Dict[str, Any]] = {}
    for claim in claims:
        claim_id = str(claim.get("claim_id") or "")
        if not claim_id or claim_id in records:
            raise RuntimeError("integration_invalid_claim_id")
        primary_note = str(claim.get("primary_note") or note_path)
        if not _source_note(primary_note) or primary_note not in baselines:
            raise RuntimeError(f"integration_claim_source_mismatch: {claim_id}")
        if primary_note != note_path:
            from wiki_knowledge import _approved, _frontmatter as review_frontmatter
            reviewed_text = _text(baselines[primary_note])
            if not _approved(reviewed_text, review_frontmatter(reviewed_text)):
                raise RuntimeError(f"integration_claim_source_unreviewed: {claim_id}")
        evidence = claim.get("evidence")
        if not isinstance(evidence, list) or not evidence or not all(isinstance(item, str) for item in evidence):
            raise RuntimeError(f"integration_claim_evidence_missing: {claim_id}")
        records[claim_id] = {"evidence": set(evidence), "primary_note": primary_note}
    old_ids = {claim_id for path, data in baselines.items() if _canonical(path)
               for claim_id in _CLAIM.findall(_text(data))}
    for relative in changed:
        old, new = _text(baselines.get(relative, b"")), _text(files[relative])
        _preserve_metadata(old, new, relative)
        if not set(_CLAIM.findall(old)).issubset(_CLAIM.findall(new)):
            raise RuntimeError(f"integration_old_claim_lost: {relative}")
        if not _source_targets(old).issubset(_source_targets(new)):
            raise RuntimeError(f"integration_source_link_lost: {relative}")
        if any(block not in new for block in _human_blocks(old)):
            raise RuntimeError(f"integration_human_content_changed: {relative}")
        previous_blocks: Dict[str, set[str]] = {}
        proposed_blocks: Dict[str, set[str]] = {}
        for text, blocks in ((old, previous_blocks), (new, proposed_blocks)):
            for marker in _CLAIM.finditer(text):
                signature = re.sub(r"\s+", " ", _claim_block(text, marker)).strip()
                blocks.setdefault(marker.group(1), set()).add(signature)
        for claim_id, signatures in previous_blocks.items():
            if not signatures.issubset(proposed_blocks.get(claim_id, set())):
                raise RuntimeError(f"integration_existing_claim_changed: {relative}:{claim_id}; keep original conditions and add corrections with a new claim ID")
        markers = list(_CLAIM.finditer(new))
        if any(match.group(1) not in records and match.group(1) not in old_ids for match in markers):
            raise RuntimeError(f"integration_unknown_claim: {relative}")
        current = [match for match in markers if match.group(1) in records]
        if not any(records[match.group(1)]["primary_note"] == note_path for match in current) or not _note_link_present(new, note_path, baselines):
            raise RuntimeError(f"integration_current_evidence_missing: {relative}")
        for match in current:
            record = records[match.group(1)]
            evidence = record["evidence"]
            primary_note = record["primary_note"]
            block = _claim_block(new, match)
            block_links = _targets(block)
            originals = {link for link in block_links if re.search(r"\.pdf#page=[1-9]\d*$", link)}
            if primary_note.startswith("wiki/papers/"):
                if not originals or not originals.issubset(evidence):
                    raise RuntimeError(f"integration_claim_page_mismatch: {relative}:{match.group(1)}")
            else:
                originals.update(link for link in block_links if re.search(r"\.md#[^#]+$", link)
                                 and link.split("#", 1)[0] != primary_note)
                if not originals or not originals.issubset(evidence):
                    raise RuntimeError(f"integration_experiment_location_missing: {relative}:{match.group(1)}")
            if not _note_link_present(block, primary_note, baselines):
                raise RuntimeError(f"integration_claim_note_mismatch: {relative}:{match.group(1)}")
    return changed


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".integration-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def publish_integration_candidate(
    vault: Path, workspace: Path, baselines: Dict[str, bytes],
    changed_paths: Iterable[str],
    *, runner_owned_paths: Iterable[str] = (),
) -> None:
    vault, workspace = Path(vault).resolve(), Path(workspace).resolve()
    changed = sorted({_relative(path) for path in changed_paths})
    runner_owned = {_relative(path) for path in runner_owned_paths}
    if any(path not in baselines or not (path == "wiki/index.md" or _source_note(path))
           for path in runner_owned):
        raise RuntimeError("integration_invalid_runner_owned_path")
    if any(not _canonical(path) and path not in runner_owned for path in changed):
        raise RuntimeError("integration_unauthorized_publish")
    for relative, baseline in baselines.items():
        path = vault / relative
        if path.is_symlink() or not path.is_file() or path.read_bytes() != baseline:
            raise RuntimeError(f"integration_edit_conflict: {relative}")
    payloads = {}
    for relative in changed:
        destination, candidate = vault / relative, workspace / relative
        if relative not in baselines and os.path.lexists(destination):
            raise RuntimeError(f"integration_edit_conflict: {relative}")
        if candidate.is_symlink() or not candidate.is_file():
            raise RuntimeError(f"integration_candidate_missing: {relative}")
        if not destination.parent.resolve().is_relative_to(vault):
            raise RuntimeError(f"integration_invalid_destination: {relative}")
        payloads[relative] = candidate.read_bytes()
    written = []
    try:
        for relative in changed:
            _atomic_write(vault / relative, payloads[relative])
            written.append(relative)
    except Exception as error:
        rollback_errors = []
        for relative in reversed(written):
            try:
                if relative in baselines:
                    _atomic_write(vault / relative, baselines[relative])
                else:
                    (vault / relative).unlink()
            except Exception as rollback_error:
                rollback_errors.append(f"{relative}: {rollback_error}")
        detail = "; rollback failed: " + "; ".join(rollback_errors) if rollback_errors else ""
        raise RuntimeError(f"integration_publish_failed: {error}{detail}") from error

"""Normalize one complete canonical candidate without models or file writes.

The caller still restores human content, validates old claims and provenance,
and checks live baselines before publication. This module does not replace those
checks or fall back to overwriting live content when normalization fails.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Tuple

import integration_candidate as I


_ARRAY_FIELDS = ("sources", "tags", "related", "aliases")
_IDENTITY_FIELDS = ("type", "title", "created")
_QUESTION_FIELDS = ("status", "question_status", "priority")
_FIELD = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):")
_HEADING = re.compile(r"(?m)^(#{1,6})[ \t]+(.+?)\s*$")


def _parts(text: str) -> Tuple[str, str, str, Dict[str, Tuple[str, List[str]]], str]:
    bom = "\ufeff" if text.startswith("\ufeff") else ""
    content = text[len(bom):]
    match = I._FRONTMATTER.match(content)
    if not match:
        if content.startswith(("---\n", "---\r\n")):
            raise RuntimeError("canonical_merge_malformed_frontmatter")
        return bom, "", content, {}, "\n"
    header = match.group(1)
    for line in header.splitlines():
        if (line.strip() and not line.lstrip().startswith("#")
                and not line[0].isspace() and not _FIELD.match(line)):
            raise RuntimeError("canonical_merge_unknown_metadata_line")
    return bom, header, content[match.end():], I._frontmatter(content), "\r\n" if "\r\n" in content[:match.end()] else "\n"


def _scalar_field(fields: Dict[str, Tuple[str, List[str]]], key: str) -> str:
    raw, continued = fields[key]
    if continued:
        raise RuntimeError(f"canonical_merge_unknown_scalar: {key}")
    return I._scalar(raw)


def _set_field(header: str, key: str, serialized: str, newline: str) -> str:
    """Replace one owned field while retaining opaque metadata and comments."""
    lines = header.splitlines()
    index = next((index for index, line in enumerate(lines)
                  if _FIELD.match(line) and _FIELD.match(line).group(1) == key), None)
    replacement = f"{key}: {serialized}"
    if index is None:
        return newline.join([*lines, replacement])
    end = next((following for following in range(index + 1, len(lines))
                if _FIELD.match(lines[following])), len(lines))
    comments_and_spacing = [line for line in lines[index + 1:end]
                            if not line.strip() or line.lstrip().startswith("#")]
    return newline.join([*lines[:index], replacement, *comments_and_spacing, *lines[end:]])


def _raw_field(header: str, key: str, newline: str) -> str:
    lines = header.splitlines()
    start = next(index for index, line in enumerate(lines)
                 if _FIELD.match(line) and _FIELD.match(line).group(1) == key)
    end = next((index for index in range(start + 1, len(lines))
                if _FIELD.match(lines[index])), len(lines))
    return newline.join(lines[start:end])


def _render(bom: str, header: str, body: str, newline: str) -> str:
    return bom + (f"---{newline}{header}{newline}---{newline}" if header else "") + body


def _protected_ranges(body: str) -> List[Tuple[int, int]]:
    spans = []
    for block in I._human_blocks(body):
        start = 0
        while True:
            start = body.find(block, start)
            if start < 0:
                break
            spans.append((start, start + len(block)))
            start += max(1, len(block))
    fence_start = None
    fence = ""
    offset = 0
    for line in body.splitlines(keepends=True):
        match = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if match:
            marker = match.group(1)
            if fence_start is None:
                fence_start, fence = offset, marker
            elif marker[0] == fence[0] and len(marker) >= len(fence):
                spans.append((fence_start, offset + len(line)))
                fence_start, fence = None, ""
        offset += len(line)
    if fence_start is not None:
        spans.append((fence_start, len(body)))
    return spans


def _evidence_block(text: str) -> bool:
    return any(re.search(r"\.pdf#page=[1-9]\d*(?:$|\s)", target)
               or re.search(r"\.md#[^\s]+$", target)
               for target in I._source_targets(text))


def _deduplicate_evidence(body: str) -> Tuple[str, int]:
    protected = _protected_ranges(body)
    sections: List[Tuple[int, str]] = []
    seen = set()
    output = []
    offset = 0
    removed = 0
    skip_separator = False
    for chunk in re.split(r"(\r?\n[ \t]*\r?\n)", body):
        start, end = offset, offset + len(chunk)
        offset = end
        if re.fullmatch(r"\r?\n[ \t]*\r?\n", chunk):
            if skip_separator:
                skip_separator = False
            else:
                output.append(chunk)
            continue
        headings = list(_HEADING.finditer(chunk))
        for heading in headings:
            level = len(heading.group(1))
            sections = [section for section in sections if section[0] < level]
            sections.append((level, heading.group(2)))
        overlaps = any(start < protected_end and end > protected_start
                       for protected_start, protected_end in protected)
        if overlaps or headings:
            output.append(chunk)
            continue
        lines = chunk.splitlines(keepends=True)
        if any(line.lstrip().startswith("|") for line in lines):
            # A row in another table can serve another purpose; only dedupe
            # literally identical evidence rows within this table block.
            rows = set()
            kept = []
            for line in lines:
                key = line.rstrip("\r\n")
                if line.lstrip().startswith("|") and _evidence_block(line):
                    if key in rows:
                        removed += 1
                        continue
                    rows.add(key)
                kept.append(line)
            output.append("".join(kept))
        elif _evidence_block(chunk):
            key = (tuple(sections), chunk.strip("\r\n"))
            if key in seen:
                removed += 1
                skip_separator = True
            else:
                seen.add(key)
                output.append(chunk)
        else:
            output.append(chunk)
    return "".join(output), removed


def merge_canonical_content(existing: str, incoming: str, path: str,
                            updated_date: str) -> Tuple[str, Dict[str, Any]]:
    """Return a normalized complete candidate, or raise without a fallback."""
    path = I._relative(path)
    if not I._canonical(path):
        raise RuntimeError("canonical_merge_noncanonical_path")
    details: Dict[str, Any] = {
        "changed": False, "mode": "identical", "model_calls": 0,
        "locked_fields_restored": [], "array_union_fields": [],
        "deduplicated_blocks": 0, "preserved_extra_fields": [], "diagnostics": [],
    }
    if existing == incoming:
        return existing, details
    old_bom, old_header, old_body, old_fields, _ = _parts(existing)
    bom, header, body, new_fields, newline = _parts(incoming)
    if old_header and not header:
        raise RuntimeError("canonical_merge_incoming_frontmatter_missing")
    if not isinstance(updated_date, str) or not updated_date.strip():
        raise RuntimeError("canonical_merge_updated_date_missing")
    for key in _ARRAY_FIELDS:
        if key not in old_fields and key not in new_fields:
            continue
        before, after = I._list(old_fields, key), I._list(new_fields, key)
        union = list(dict.fromkeys([*before, *after]))
        header = _set_field(header, key, json.dumps(union, ensure_ascii=False), newline)
        if union != after:
            details["array_union_fields"].append(key)
    locked = [*_IDENTITY_FIELDS]
    if path.startswith("wiki/questions/"):
        locked.extend(_QUESTION_FIELDS)
    owned = {*_ARRAY_FIELDS, *locked, "updated"}
    for key in old_fields:
        if key not in owned and key not in new_fields:
            header = newline.join([header, _raw_field(old_header, key, newline)])
            details["preserved_extra_fields"].append(key)
    for key in locked:
        if key in new_fields:
            _scalar_field(new_fields, key)
        if key not in old_fields:
            continue
        value = _scalar_field(old_fields, key)
        incoming_value = _scalar_field(new_fields, key) if key in new_fields else None
        if incoming_value != value or new_fields[key][0] != old_fields[key][0]:
            # Restore the old scalar token as well as its value. In particular,
            # numeric priority and null metadata must not become quoted strings.
            header = _set_field(header, key, old_fields[key][0], newline)
            details["locked_fields_restored"].append(key)
    body, count = _deduplicate_evidence(body)
    details["deduplicated_blocks"] = count
    if len(body) < len(old_body):
        details["diagnostics"].append({"kind": "body_shortened", "existing_chars": len(old_body),
                                       "candidate_chars": len(body)})
    missing_ids = sorted(set(I._CLAIM.findall(old_body)) - set(I._CLAIM.findall(body)))
    if missing_ids:
        details["diagnostics"].append({"kind": "old_claim_markers_missing", "claim_ids": missing_ids})
    candidate = _render(old_bom or bom, header, body, newline)
    if candidate == existing:
        details["mode"] = "normalized_no_op"
        return existing, details
    if header:
        if "updated" in old_fields:
            _scalar_field(old_fields, "updated")
        if "updated" in new_fields:
            _scalar_field(new_fields, "updated")
        header = _set_field(header, "updated", json.dumps(updated_date, ensure_ascii=False), newline)
        candidate = _render(old_bom or bom, header, body, newline)
    details["changed"] = candidate != existing
    details["mode"] = "new_page" if not existing else "metadata_only" if body == old_body else "body_candidate"
    return candidate, details

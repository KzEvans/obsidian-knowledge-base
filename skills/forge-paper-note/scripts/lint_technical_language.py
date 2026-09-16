#!/usr/bin/env python3
"""Validate the technical-language audit for an evidence-grounded paper note."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any


ACQUISITION_TYPES = {
    "measured",
    "fitted",
    "derived",
    "graph_read",
    "author_interpretation",
}
TERMINOLOGY_FIELDS = (
    "source_term",
    "preferred_rendering",
    "definition",
    "source_pages",
)
PROTOCOL_FIELDS = (
    "step",
    "source_action",
    "actor_or_object",
    "quantity",
    "conditions",
    "operation",
    "output",
    "missing_fields",
    "source_pages",
)
MEASUREMENT_FIELDS = (
    "quantity",
    "symbol",
    "operational_definition",
    "acquisition_type",
    "unit",
    "sample_basis",
    "source_pages",
)
REVIEW_FLAGS = (
    "source_target_alignment_checked",
    "quantities_and_units_checked",
    "operator_object_checked",
    "missing_values_not_filled",
    "measurement_types_labeled",
    "terminology_consistency_checked",
    "domain_heading_adapted",
)
UNIT_WARNING_FIELDS = ("reported_form", "reason_for_review", "action")
MATERIAL_HEADINGS = {
    "zh-CN": (
        "材料制备步骤",
        "表征与测试条件",
        "研究对象与关键对照",
        "评价量与获取方式",
    ),
    "en": (
        "Material Preparation Steps",
        "Characterization and Test Conditions",
        "Study Objects and Key Comparisons",
        "Quantities and How They Were Obtained",
    ),
}
MEASUREMENT_LABELS = {
    "zh-CN": {
        "measured": ("实测", "直接测量", "直接观察"),
        "fitted": ("拟合",),
        "derived": ("派生", "计算"),
        "graph_read": ("图估读", "图中估读"),
        "author_interpretation": ("作者解释", "作者推断"),
    },
    "en": {
        "measured": ("measured", "observed"),
        "fitted": ("fitted",),
        "derived": ("derived", "calculated"),
        "graph_read": ("graph-read", "read from the plot"),
        "author_interpretation": ("author interpretation",),
    },
}
PROHIBITED_PHRASES = {
    "zh-CN": ("任务与评价量", "本文不是一个公开数据集任务"),
    "en": ("Task and Evaluation Metrics", "not a public dataset task"),
}
HEADING_RE = re.compile(r"^(#{2,3})[ \t]+(.+?)[ \t]*$", re.MULTILINE)
ORDERED_STEP_RE = re.compile(r"(?m)^\s*\d+[.)、]\s+")
PDF_PAGE_LINK_RE = re.compile(
    r"\[\[[^\]\n]+\.pdf#page=(\d+)\\?\|(?:(?:PDF|SI)\s+)?p\.(\d+)\]\]",
    re.IGNORECASE,
)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--input", required=True, help="Markdown note path.")
    result.add_argument("--plan-file", default="", help="Technical-language note_plan JSON.")
    result.add_argument("--language", choices=("zh-CN", "en"), default="zh-CN")
    result.add_argument("--output", default="", help="Optional JSON report path.")
    result.add_argument("--require-plan", action="store_true")
    result.add_argument("--minimum-terms", type=int, default=5)
    result.add_argument("--minimum-protocol-steps", type=int, default=3)
    result.add_argument("--minimum-measurements", type=int, default=5)
    return result


def normalize_heading(value: str) -> str:
    value = re.sub(r"\s+", " ", value.strip()).replace("`", "")
    value = re.sub(r"^\d{1,2}\s*[.)、]\s*", "", value)
    return value.casefold()


def normalize_reported_form(value: str) -> str:
    """Normalize equivalent Markdown/Unicode unit notation for comparison."""
    normalized = unicodedata.normalize("NFKC", value).casefold()
    normalized = normalized.replace("−", "-").replace("–", "-").replace("—", "-")
    normalized = re.sub(r"\^(?=[+-]?\d)", "", normalized)
    return re.sub(r"[\s`$\\{}]", "", normalized)


def reported_form_present(reported_form: str, human_review: str) -> bool:
    needle = normalize_reported_form(reported_form)
    return bool(needle) and needle in normalize_reported_form(human_review)


def heading_blocks(text: str) -> dict[str, str]:
    matches = list(HEADING_RE.finditer(text))
    blocks: dict[str, str] = {}
    for index, match in enumerate(matches):
        level = len(match.group(1))
        end = len(text)
        for later in matches[index + 1 :]:
            if len(later.group(1)) <= level:
                end = later.start()
                break
        blocks[normalize_heading(match.group(2))] = text[match.end() : end].strip()
    return blocks


def nonempty(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list):
        return bool(value)
    if isinstance(value, (int, float)):
        return True
    return False


def items_valid(items: Any, fields: tuple[str, ...]) -> bool:
    return isinstance(items, list) and all(
        isinstance(item, dict) and all(nonempty(item.get(field)) for field in fields)
        for item in items
    )


def protocol_items_valid(items: Any) -> bool:
    required_nonempty = tuple(field for field in PROTOCOL_FIELDS if field != "missing_fields")
    return isinstance(items, list) and all(
        isinstance(item, dict)
        and all(nonempty(item.get(field)) for field in required_nonempty)
        and isinstance(item.get("missing_fields"), list)
        for item in items
    )


def load_plan(path_value: str) -> tuple[dict[str, Any], str]:
    if not path_value:
        return {}, ""
    path = Path(path_value).expanduser().resolve()
    if not path.is_file():
        return {}, "plan_file_missing"
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}, "plan_file_invalid_json"
    if not isinstance(value, dict):
        return {}, "plan_file_not_object"
    return value, ""


def has_asserted_avoided_term(text: str, term: str) -> bool:
    for match in re.finditer(re.escape(term), text):
        prefix = text[max(0, match.start() - 32):match.start()]
        if re.search(r"(?:不应|不能|不要|避免|不得|并非|不是|不宜|勿|误译为)[^。；\n]{0,22}$|(?:not|avoid|incorrectly|do not)[^.!?\n]{0,22}$", prefix, re.IGNORECASE):
            continue
        return True
    return False


def main() -> int:
    args = parser().parse_args()
    note_path = Path(args.input).expanduser().resolve()
    issues: list[str] = []

    if not note_path.is_file():
        issues.append("note_missing")
        text = ""
        note_bytes = b""
    else:
        note_bytes = note_path.read_bytes()
        try:
            text = note_bytes.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = ""
            issues.append("note_not_utf8")

    plan, plan_error = load_plan(args.plan_file)
    if plan_error:
        issues.append(plan_error)
    if args.require_plan and not args.plan_file:
        issues.append("plan_file_required")

    terms = plan.get("terminology_ledger")
    protocols = plan.get("protocol_ledger")
    measurements = plan.get("measurement_ledger")
    warnings = plan.get("reported_unit_warnings", [])
    review = plan.get("translation_review")
    material_required = bool(
        isinstance(plan.get("domain_adaptation"), dict)
        and plan["domain_adaptation"].get("material_preparation_required") is True
    )

    if not items_valid(terms, TERMINOLOGY_FIELDS):
        issues.append("terminology_ledger_invalid")
    elif len(terms) < args.minimum_terms:
        issues.append("terminology_ledger_too_small")
    else:
        for item in terms:
            avoid = item.get("avoid", [])
            if avoid and not isinstance(avoid, list):
                issues.append("terminology_avoid_not_list")
                break
            if isinstance(avoid, list) and any(
                isinstance(term, str) and term.strip() and has_asserted_avoided_term(text, term) for term in avoid
            ):
                issues.append("avoided_term_found_in_note")
                break

    if material_required:
        if not protocol_items_valid(protocols):
            issues.append("protocol_ledger_invalid")
        elif len(protocols) < args.minimum_protocol_steps:
            issues.append("protocol_ledger_too_small")
    elif protocols is not None and not protocol_items_valid(protocols):
        issues.append("protocol_ledger_invalid")

    if not items_valid(measurements, MEASUREMENT_FIELDS):
        issues.append("measurement_ledger_invalid")
        acquisition_types: set[str] = set()
    else:
        acquisition_types = {str(item["acquisition_type"]) for item in measurements}
        if len(measurements) < args.minimum_measurements:
            issues.append("measurement_ledger_too_small")
        if not acquisition_types.issubset(ACQUISITION_TYPES):
            issues.append("measurement_acquisition_type_invalid")
        if "measured" not in acquisition_types:
            issues.append("measured_quantity_missing")
        if not ({"fitted", "derived"} & acquisition_types):
            issues.append("fitted_or_derived_quantity_missing")

    if not isinstance(warnings, list) or not all(
        isinstance(item, dict) and all(nonempty(item.get(field)) for field in UNIT_WARNING_FIELDS)
        for item in warnings
    ):
        issues.append("reported_unit_warnings_invalid")

    if not isinstance(review, dict):
        issues.append("translation_review_missing")
    else:
        for flag in REVIEW_FLAGS:
            if review.get(flag) is not True:
                issues.append(f"translation_review_{flag}_not_passed")
        if not nonempty(review.get("review_notes")):
            issues.append("translation_review_notes_missing")

    blocks = heading_blocks(text)
    if material_required:
        for heading in MATERIAL_HEADINGS[args.language]:
            block = blocks.get(normalize_heading(heading), "")
            if not block:
                issues.append(f"material_heading_missing:{heading}")
            elif not PDF_PAGE_LINK_RE.search(block):
                issues.append(f"material_heading_page_link_missing:{heading}")
        preparation = blocks.get(normalize_heading(MATERIAL_HEADINGS[args.language][0]), "")
        if len(ORDERED_STEP_RE.findall(preparation)) < args.minimum_protocol_steps:
            issues.append("material_preparation_not_stepwise")

    for phrase in PROHIBITED_PHRASES[args.language]:
        if phrase.casefold() in text.casefold():
            issues.append(f"domain_inappropriate_phrase:{phrase}")

    quantities_heading = MATERIAL_HEADINGS[args.language][-1]
    quantities_block = blocks.get(normalize_heading(quantities_heading), "")
    if quantities_block and acquisition_types:
        represented = {
            kind
            for kind, labels in MEASUREMENT_LABELS[args.language].items()
            if any(label.casefold() in quantities_block.casefold() for label in labels)
        }
        required_represented = acquisition_types & {"measured", "fitted", "derived"}
        if not required_represented.issubset(represented):
            issues.append("measurement_types_not_visible_in_note")

    human_review = blocks.get(normalize_heading("人工复核" if args.language == "zh-CN" else "Human Review"), "")
    for item in warnings if isinstance(warnings, list) else []:
        reported_form = str(item.get("reported_form", "")).strip()
        if reported_form and not reported_form_present(reported_form, human_review):
            issues.append("reported_unit_warning_missing_from_human_review")
            break

    report = {
        "script": "lint_technical_language.py",
        "input": str(note_path),
        "plan_file": str(Path(args.plan_file).expanduser().resolve()) if args.plan_file else "",
        "language": args.language,
        "material_preparation_required": material_required,
        "counts": {
            "terminology_entries": len(terms) if isinstance(terms, list) else 0,
            "protocol_entries": len(protocols) if isinstance(protocols, list) else 0,
            "measurement_entries": len(measurements) if isinstance(measurements, list) else 0,
            "reported_unit_warnings": len(warnings) if isinstance(warnings, list) else 0,
        },
        "acquisition_types": sorted(acquisition_types),
        "issues": sorted(set(issues)),
        "passed": not issues,
        "note_sha256": hashlib.sha256(note_bytes).hexdigest() if note_bytes else "",
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        Path(args.output).expanduser().resolve().write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Compare fixed top-four local retrieval against explicitly supplied relevance cases."""
from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import importlib
import importlib.util
import json
from pathlib import Path
import re
import sys
from typing import Any


LIMIT = 4
ROOT = Path(__file__).resolve().parents[1]


def relative_note(value: str, vault: Path) -> str:
    path = Path(value)
    if path.is_absolute():
        return path.resolve().relative_to(vault.resolve()).as_posix()
    if not value or ".." in path.parts:
        raise ValueError(f"Expected a vault-relative note path: {value}")
    return path.as_posix()


def load_cases(path: Path, vault: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    items = payload.get("cases") if isinstance(payload, dict) else payload
    if not isinstance(items, list) or not items:
        raise ValueError("The case file must contain a nonempty cases array")
    cases = []
    ids = set()
    for index, item in enumerate(items, 1):
        if not isinstance(item, dict) or not isinstance(item.get("question"), str) or not item["question"].strip():
            raise ValueError(f"Case {index} needs a nonempty question")
        expected = item.get("expected_notes", [])
        if not isinstance(expected, list) or not all(isinstance(note, str) for note in expected):
            raise ValueError(f"Case {index} expected_notes must be an array of paths")
        empty = item.get("expected_empty", False)
        if not isinstance(empty, bool) or empty == bool(expected):
            raise ValueError(f"Case {index} needs expected notes or an explicit expected_empty negative")
        case_id = str(item.get("id", f"case-{index:02d}"))
        if case_id in ids:
            raise ValueError(f"Repeated case id: {case_id}")
        ids.add(case_id)
        case = dict(item, id=case_id, expected_empty=empty,
                    expected_notes=list(dict.fromkeys(relative_note(note, vault) for note in expected)))
        if item.get("anchor_note"):
            case["anchor_note"] = relative_note(item["anchor_note"], vault)
        cases.append(case)
    metadata = {key: value for key, value in payload.items() if key != "cases"} if isinstance(payload, dict) else {}
    return cases, metadata


def load_baseline(path: Path):
    """The explicit CLI path is a trusted local code module, not source-note data."""
    path = path.expanduser().resolve(strict=True)
    if path.suffix != ".py" or not path.is_file():
        raise ValueError("--baseline-controlled must identify a local Python module")
    name = "knowledge_retrieval_controlled_baseline"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError(f"Cannot load baseline module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    if not callable(getattr(module, "knowledge_context", None)):
        raise ValueError("The baseline must expose knowledge_context")
    return module


def record_type(vault: Path, note: str) -> str:
    try:
        with (vault / note).open(encoding="utf-8-sig") as handle:
            head = handle.read(8000)
    except (OSError, UnicodeError):
        return "unavailable"
    frontmatter = re.match(r"\A---\s*\n(.*?)\n---", head, re.S)
    kind = re.search(r"(?m)^type:\s*['\"]?([^'\"\n]+)", frontmatter.group(1)) if frontmatter else None
    value = kind.group(1).strip() if kind else ""
    if note.startswith("wiki/papers/"):
        return "paper_source_note" if value == "paper" else "user_record_or_untyped"
    if note.startswith("wiki/experiments/"):
        return "experiment_source_note" if value else "user_record_or_untyped"
    return "canonical_or_other_note"


def run_case(module: Any, case: dict[str, Any], vault: Path) -> dict[str, Any]:
    error = None
    warnings = []
    ranked = []
    try:
        payload = module.knowledge_context(vault, case["question"], case.get("anchor_note"), limit=LIMIT)
        if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
            raise ValueError("Retrieval must return a results array")
        warnings = payload.get("warnings", [])
        for rank, row in enumerate(payload["results"][:LIMIT], 1):
            note = relative_note(row["note_path"], vault)
            ranked.append({"rank": rank, "note_path": note, "title": row.get("title", Path(note).stem),
                           "status": row.get("status"), "reviewed": row.get("reviewed") is True,
                           "record_type": record_type(vault, note), "score": row.get("score"),
                           "reasons": row.get("reasons", [])})
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        ranked = []
    expected = set(case["expected_notes"])
    hits = expected.intersection(row["note_path"] for row in ranked)
    first = next((row["rank"] for row in ranked if row["note_path"] in expected), None)
    return {
        "top4": ranked, "returned_count": len(ranked), "warnings": warnings, "error": error,
        "recall_at_4": len(hits) / len(expected) if expected else None,
        "first_expected_rank": first, "rr_at_4": 1 / first if first else 0.0,
        "negative_correct": not ranked and error is None if case["expected_empty"] else None,
        "user_record_or_untyped_hits": sum(row["record_type"] == "user_record_or_untyped" for row in ranked),
    }


def change_label(case: dict[str, Any], before: dict[str, Any], after: dict[str, Any]) -> str:
    if case["expected_empty"]:
        deltas = [int(after["negative_correct"]) - int(before["negative_correct"])]
    else:
        deltas = [after[key] - before[key] for key in ("recall_at_4", "rr_at_4")]
    if all(delta == 0 for delta in deltas):
        return "unchanged"
    if all(delta >= 0 for delta in deltas):
        return "improved"
    if all(delta <= 0 for delta in deltas):
        return "regressed"
    return "mixed"


def summarize(rows: list[dict[str, Any]], engine: str) -> dict[str, Any]:
    positive = [row[engine] for row in rows if not row["expected_empty"]]
    negative = [row[engine] for row in rows if row["expected_empty"]]
    return {
        "positive_cases": len(positive), "negative_cases": len(negative),
        "mean_recall_at_4": sum(row["recall_at_4"] for row in positive) / len(positive) if positive else None,
        "mrr_at_4": sum(row["rr_at_4"] for row in positive) / len(positive) if positive else None,
        "negative_empty_accuracy": sum(row["negative_correct"] for row in negative) / len(negative) if negative else None,
        "errors": sum(row[engine]["error"] is not None for row in rows),
        "user_record_or_untyped_hits": sum(row[engine]["user_record_or_untyped_hits"] for row in rows),
    }


def evaluate(cases: list[dict[str, Any]], vault: Path, baseline: Any, current: Any) -> dict[str, Any]:
    rows = []
    for case in cases:
        before = run_case(baseline, case, vault)
        after = run_case(current, case, vault)
        rows.append({**case, "baseline": before, "current": after, "change": change_label(case, before, after)})
    return {"limit": LIMIT, "cases": rows,
            "summary": {engine: summarize(rows, engine) for engine in ("baseline", "current")},
            "changes": {label: sum(row["change"] == label for row in rows)
                        for label in ("improved", "unchanged", "regressed", "mixed")}}


def markdown_report(report: dict[str, Any]) -> str:
    def cell(value: Any) -> str:
        return str(value).replace("|", "\\|").replace("\n", " ")
    def number(value: Any) -> str:
        return "—" if value is None else str(value) if isinstance(value, int) else f"{value:.3f}"
    labels = {"improved": "改善", "unchanged": "无变化", "regressed": "退步", "mixed": "指标有升有降"}
    lines = ["# 本地知识检索对照评估", "",
             "本报告使用预先定义的库内笔记相关性标注，未由用户指定为金标准，也不验证论文结论。草稿仅提供相关性线索；用户记录或未标类型命中单独标注。",
             "固定返回前 4 条，所有案例均保留。正例记录 Recall@4、首个预期命中名次与 RR@4；MRR@4 是正例的平均 RR。负例要求成功检索且返回 0 条，错误不能算负例通过。", "",
             f"案例 SHA256：`{report.get('cases_sha256', 'not recorded')}`", "",
             "## 汇总", "", "| 指标 | 改前 | 当前 |", "|---|---|---|"]
    for key in ("mean_recall_at_4", "mrr_at_4", "negative_empty_accuracy", "errors", "user_record_or_untyped_hits"):
        lines.append(f"| {key} | {number(report['summary']['baseline'][key])} | {number(report['summary']['current'][key])} |")
    lines.extend(["", "变化：" + "；".join(f"{labels[key]} {value}" for key, value in report["changes"].items()), "",
                  "## 全部案例", "", "| 案例 | 原 Recall@4 | 新 Recall@4 | 原首命中 | 新首命中 | 原 RR@4 | 新 RR@4 | 变化 |", "|---|---|---|---|---|---|---|---|"])
    for row in report["cases"]:
        before, after = row["baseline"], row["current"]
        label = labels[row["change"]]
        if row["expected_empty"]:
            label += f"；负例 {before['negative_correct']} → {after['negative_correct']}"
        lines.append(f"| {cell(row['id'])} | {number(before['recall_at_4'])} | {number(after['recall_at_4'])} | {before['first_expected_rank'] or '—'} | {after['first_expected_rank'] or '—'} | {number(before['rr_at_4'])} | {number(after['rr_at_4'])} | {cell(label)} |")
    for row in report["cases"]:
        lines.extend(["", f"## {row['id']}", "", row["question"], "",
                      "预期来源：" + ("、".join(f"[[{note}]]" for note in row["expected_notes"]) or "无库内相关证据；预期零匹配。")])
        if row.get("rationale"):
            lines.extend(["", "标注依据：" + row["rationale"]])
        for engine, title in (("baseline", "改前 Top 4"), ("current", "当前 Top 4")):
            data = row[engine]
            lines.extend(["", f"### {title}", ""])
            if data["error"]:
                lines.append("检索错误：" + data["error"])
            elif not data["top4"]:
                lines.append("成功检索，返回 0 条。")
            for hit in data["top4"]:
                lines.append(f"{hit['rank']}. [[{hit['note_path']}|{hit['title']}]] — {hit['record_type']}；{hit['status']}；有效审核={hit['reviewed']}；score={hit['score']}")
            if data["warnings"]:
                lines.append("检索提示：" + "；".join(map(str, data["warnings"])))
    lines.extend(["", "## 可复现记录", "", "```json", json.dumps(report.get("provenance", {}), ensure_ascii=False, indent=2), "```", ""])
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", required=True, type=Path)
    parser.add_argument("--cases", required=True, type=Path)
    parser.add_argument("--baseline-controlled", required=True, type=Path,
                        help="Explicit trusted local Python baseline module; loaded as code")
    parser.add_argument("--output", required=True, type=Path, help="Output directory or report .md/.json path")
    args = parser.parse_args()
    vault = args.vault.expanduser().resolve(strict=True)
    case_file = args.cases.expanduser().resolve(strict=True)
    cases, metadata = load_cases(case_file, vault)
    sys.path.insert(0, str(ROOT / "knowledge-base/system/knowledge"))
    current = importlib.import_module("wiki_knowledge")
    baseline = load_baseline(args.baseline_controlled)
    report = evaluate(cases, vault, baseline, current)
    digest = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
    report.update(generated_at=datetime.now().astimezone().isoformat(), annotation_metadata=metadata,
                  cases_sha256=digest(case_file), provenance={
                      "cases_file": str(case_file),
                      "baseline_module": str(Path(baseline.__file__).resolve()), "baseline_sha256": digest(baseline.__file__),
                      "current_module": str(Path(current.__file__).resolve()), "current_sha256": digest(current.__file__),
                  })
    output = args.output.expanduser()
    stem = output.with_suffix("") if output.suffix in {".md", ".json"} else output / "retrieval-evaluation"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.with_suffix(".json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    stem.with_suffix(".md").write_text(markdown_report(report), encoding="utf-8")
    print(json.dumps({"report_path": str(stem.with_suffix('.md')), "json_path": str(stem.with_suffix('.json')),
                      "summary": report["summary"], "changes": report["changes"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()

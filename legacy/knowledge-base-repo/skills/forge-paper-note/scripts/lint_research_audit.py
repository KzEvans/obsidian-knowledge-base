#!/usr/bin/env python3
"""Validate the merged research-audit and knowledge-base note contract."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any


REQUIRED_HEADINGS = {
    "zh-CN": (
        "前人工作与不足",
        "重建作者的思考路径",
        "核心 Intuition",
        "实验设计与结论",
        "问题—证据—回答",
        "真正贡献是什么",
        "证据真正证明了什么",
        "最脆弱的假设",
        "最小复现实验",
        "最强反例设计",
        "哪些地方容易被误读",
        "Follow-up Research Idea",
        "与现有知识的候选关联",
        "可验证的知识声明",
        "人工复核",
    ),
    "en": (
        "Prior Work and Its Limits",
        "Reconstructing the Authors' Reasoning Path",
        "Core Intuition",
        "Experimental Design and Conclusions",
        "Question-Evidence-Answer Map",
        "What the Real Contribution Is",
        "What the Evidence Actually Proves",
        "Most Fragile Assumption",
        "Minimal Reproduction",
        "Strongest Counterexample",
        "Easy Misreadings",
        "Follow-up Research Idea",
        "Candidate Knowledge Links",
        "Verifiable Claims",
        "Human Review",
    ),
}

HEADING_NAMES = {
    "zh-CN": {
        "prior": "前人工作与不足",
        "question_answer": "问题—证据—回答",
        "followup": "Follow-up Research Idea",
        "candidates": "与现有知识的候选关联",
        "preparation": "材料制备步骤",
    },
    "en": {
        "prior": "Prior Work and Its Limits",
        "question_answer": "Question-Evidence-Answer Map",
        "followup": "Follow-up Research Idea",
        "candidates": "Candidate Knowledge Links",
        "preparation": "Material Preparation Steps",
    },
}

PRIOR_REQUIRED_FIELDS = (
    "work",
    "source_identifier",
    "existing_conclusion",
    "why_insufficient",
    "verification_status",
)
INFERENCE_REQUIRED_FIELDS = ("inference", "basis", "boundary", "target_section")
QUESTION_REQUIRED_FIELDS = (
    "question",
    "test_or_evidence",
    "answer",
    "confidence_and_gap",
)
FOLLOWUP_REQUIRED_FIELDS = (
    "driving_gap",
    "new_framing",
    "adjacent_field",
    "borrowed_tool",
    "technical_route",
    "first_experiment",
    "expected_support_signal",
    "falsification_signal",
    "key_risk",
    "novelty_status",
)
ENTITY_REQUIRED_FIELDS = (
    "entity",
    "type",
    "relation",
    "link_target",
    "selection_reason",
)
PREPARATION_REQUIRED_FIELDS = (
    "step",
    "inputs",
    "conditions",
    "operation",
    "output",
    "critical_control",
)
VERIFICATION_STATUSES = {"paper_characterization_only"}
NOVELTY_STATUSES = {"unresolved"}
ENTITY_TYPES = {
    "concept",
    "material",
    "method",
    "mechanism",
    "metric",
    "device",
    "phenomenon",
    "failure_mode",
    "dataset",
    "theory",
    "task",
    "application",
}

HEADING_RE = re.compile(r"^(#{2,3})[ \t]+(.+?)[ \t]*$", re.MULTILINE)
FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)", re.DOTALL)
PDF_PAGE_LINK_RE = re.compile(
    r"\[\[[^\]\n]+\.pdf#page=(\d+)\\?\|(?:(?:PDF|SI)\s+)?p\.(\d+)\]\]",
    re.IGNORECASE,
)
WIKILINK_RE = re.compile(r"\[\[([^\]|#\n]+)(?:#[^\]|\n]+)?(?:\|[^\]\n]+)?\]\]")
DOI_RE = re.compile(r"\b10\.\d{4,9}/[-._;()/:A-Z0-9]+", re.IGNORECASE)
URL_RE = re.compile(r"https?://[^\s)\]>]+", re.IGNORECASE)
NUMBERED_CITATION_RE = re.compile(r"\[(\d+(?:\s*[-,]\s*\d+)*)\]")
AUTHOR_YEAR_RE = re.compile(
    r"\b[A-Z][A-Za-z'’-]+(?:\s+(?:et\s+al\.?|and|&)\s+[A-Z][A-Za-z'’-]+)?"
    r"\s*(?:\(|,)\s*((?:19|20)\d{2})",
    re.IGNORECASE,
)
INFERENCE_RE = re.compile(
    r"(?im)^\s*(?:[-*]\s*)?(?:\*\*)?(?:推断|Inference)\s*[:：]"
)
ORDERED_STEP_RE = re.compile(r"(?m)^\s*\d+[.)、]\s+")
USER_NOTES_START = "<!-- user-notes:start -->"
USER_NOTES_END = "<!-- user-notes:end -->"


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--input", required=True, help="Markdown note path.")
    result.add_argument("--language", choices=("zh-CN", "en"), default="zh-CN")
    result.add_argument("--output", default="", help="Optional JSON report path.")
    result.add_argument("--plan-file", default="", help="Extended research-audit note_plan JSON.")
    result.add_argument("--require-plan", action="store_true")
    result.add_argument("--require-page-links", action="store_true")
    result.add_argument("--minimum-page-links", type=int, default=3)
    result.add_argument("--minimum-prior-sources", type=int, default=2)
    result.add_argument("--minimum-inferences", type=int, default=1)
    result.add_argument("--minimum-candidate-links", type=int, default=8)
    result.add_argument("--minimum-followup-chars", type=int, default=260)
    result.add_argument("--require-draft", action="store_true")
    result.add_argument("--require-user-note-markers", action="store_true")
    return result


def normalize_heading(value: str) -> str:
    value = re.sub(r"\s+", " ", value.strip())
    value = value.replace("`", "")
    value = re.sub(r"^\d{1,2}\s*[.)、]\s*", "", value)
    return value.casefold()


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


def block_for(blocks: dict[str, str], heading: str) -> str:
    return blocks.get(normalize_heading(heading), "")


def compact_length(value: str) -> int:
    return len(re.sub(r"\s+", "", value))


def has_draft_status(frontmatter: str) -> bool:
    return bool(re.search(r"(?m)^status:\s*[\"']?draft[\"']?\s*$", frontmatter))


def nonempty_string_fields(item: Any, fields: tuple[str, ...]) -> bool:
    return isinstance(item, dict) and all(
        isinstance(item.get(field), str) and item[field].strip() for field in fields
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


def validate_plan(
    plan: dict[str, Any], minimum_prior: int, minimum_candidates: int
) -> tuple[list[str], dict[str, object]]:
    issues: list[str] = []
    details: dict[str, object] = {}

    prior = plan.get("prior_work_matrix")
    if not isinstance(prior, list) or len(prior) < minimum_prior:
        issues.append("plan_prior_work_matrix_too_small")
        prior = []
    for index, item in enumerate(prior):
        if not nonempty_string_fields(item, PRIOR_REQUIRED_FIELDS):
            issues.append(f"plan_prior_work_item_invalid:{index}")
            continue
        if item["verification_status"] not in VERIFICATION_STATUSES:
            issues.append(f"plan_prior_work_verification_status_invalid:{index}")
    details["plan_prior_work_count"] = len(prior)

    inferences = plan.get("inference_ledger")
    if not isinstance(inferences, list) or not inferences:
        issues.append("plan_inference_ledger_empty")
        inferences = []
    for index, item in enumerate(inferences):
        if not nonempty_string_fields(item, INFERENCE_REQUIRED_FIELDS):
            issues.append(f"plan_inference_item_invalid:{index}")
    details["plan_inference_count"] = len(inferences)

    question_map = plan.get("question_answer_map")
    if not isinstance(question_map, list) or len(question_map) < 2:
        issues.append("plan_question_answer_map_too_small")
        question_map = []
    for index, item in enumerate(question_map):
        if not nonempty_string_fields(item, QUESTION_REQUIRED_FIELDS):
            issues.append(f"plan_question_answer_item_invalid:{index}")
    details["plan_question_answer_count"] = len(question_map)

    followup = plan.get("followup")
    if not nonempty_string_fields(followup, FOLLOWUP_REQUIRED_FIELDS):
        issues.append("plan_followup_incomplete")
    elif followup["novelty_status"] not in NOVELTY_STATUSES:
        issues.append("plan_followup_novelty_status_invalid")

    entities = plan.get("candidate_entity_inventory")
    if not isinstance(entities, list) or len(entities) < minimum_candidates:
        issues.append("plan_candidate_entity_inventory_too_small")
        entities = []
    elif len(entities) > 20:
        issues.append("plan_candidate_entity_inventory_too_large")
    entity_types: set[str] = set()
    for index, item in enumerate(entities):
        if not nonempty_string_fields(item, ENTITY_REQUIRED_FIELDS):
            issues.append(f"plan_candidate_entity_invalid:{index}")
            continue
        entity_type = item["type"]
        if entity_type not in ENTITY_TYPES:
            issues.append(f"plan_candidate_entity_type_invalid:{index}")
        else:
            entity_types.add(entity_type)
    if len(entity_types) < 4:
        issues.append("plan_candidate_entity_type_coverage_too_small")
    details["plan_candidate_entity_count"] = len(entities)
    details["plan_candidate_entity_types"] = sorted(entity_types)

    domain = plan.get("domain_adaptation")
    material_required = False
    if not isinstance(domain, dict) or not isinstance(
        domain.get("material_preparation_required"), bool
    ) or not isinstance(domain.get("reason"), str) or not domain["reason"].strip():
        issues.append("plan_domain_adaptation_invalid")
    else:
        material_required = domain["material_preparation_required"]
    details["material_preparation_required"] = material_required

    steps = plan.get("preparation_steps")
    if material_required:
        if not isinstance(steps, list) or len(steps) < 3:
            issues.append("plan_preparation_steps_too_small")
            steps = []
        for index, item in enumerate(steps):
            if not nonempty_string_fields(item, PREPARATION_REQUIRED_FIELDS):
                issues.append(f"plan_preparation_step_invalid:{index}")
    elif steps is not None and not isinstance(steps, list):
        issues.append("plan_preparation_steps_invalid")
    details["plan_preparation_step_count"] = len(steps) if isinstance(steps, list) else 0

    return issues, details


def prior_source_tokens(block: str) -> list[str]:
    tokens: set[str] = set()
    tokens.update(match.group(0).lower().rstrip(".,;)") for match in DOI_RE.finditer(block))
    for match in URL_RE.finditer(block):
        url = match.group(0).lower().rstrip(".,;)")
        doi = DOI_RE.search(url)
        tokens.add(doi.group(0).lower().rstrip(".,;)") if doi else url)
    for match in NUMBERED_CITATION_RE.finditer(block):
        for number in re.findall(r"\d+", match.group(1)):
            tokens.add(f"ref:{number}")
    for match in AUTHOR_YEAR_RE.finditer(block):
        tokens.add(f"author-year:{match.group(0).lower()}")
    return sorted(tokens)


def prior_semantics_pass(block: str, language: str) -> bool:
    if language == "zh-CN":
        achievement = r"已有结论|已经|已能|能够|表明|发现|证明|提出|实现|达到"
        insufficiency = r"不足|限制|代价|缺口|仍未|不能|无法|尚未|不适用"
    else:
        achievement = r"established|showed|demonstrated|achieved|found|enabled|proved"
        insufficiency = r"limit|gap|cost|cannot|does not|missing|unresolved|insufficient"
    return bool(re.search(achievement, block, re.IGNORECASE)) and bool(
        re.search(insufficiency, block, re.IGNORECASE)
    )


def prior_scope_disclosure_pass(block: str, language: str) -> bool:
    if language == "zh-CN":
        return bool(re.search(r"仅依据本文转述|依据当前论文转述", block)) and bool(
            re.search(r"未独立核验|没有独立核验", block)
        )
    return bool(
        re.search(r"current paper(?:'s)? characterization|based only on the current paper", block, re.IGNORECASE)
    ) and bool(re.search(r"not independently verified", block, re.IGNORECASE))


def question_answer_pass(block: str, language: str) -> bool:
    if language == "zh-CN":
        groups = (r"问题|假设", r"证据|实验|比较|论证", r"回答|答案|结论", r"置信|边界|仍|未解决|缺口")
    else:
        groups = (
            r"question|hypothesis",
            r"evidence|experiment|comparison|argument|test",
            r"answer|conclusion",
            r"confidence|boundary|remaining|unresolved|gap",
        )
    return compact_length(block) >= 100 and all(
        re.search(pattern, block, re.IGNORECASE) for pattern in groups
    )


def followup_pass(block: str, language: str, minimum_chars: int) -> tuple[bool, list[str]]:
    patterns = {
        "driving_gap": r"局限|缺口|未满足|脆弱假设|需求" if language == "zh-CN" else r"gap|limitation|unmet|fragile assumption|need",
        "new_framing": r"新(?:的)?问题|新(?:的)?框架|重新定义|目标|因果问题" if language == "zh-CN" else r"new framing|reframe|objective|causal question",
        "adjacent_tool": r"相邻|借鉴|工具|原理|领域" if language == "zh-CN" else r"adjacent|borrow|tool|principle|field",
        "experiment": r"首个.{0,12}实验|第一.{0,12}实验|实验设计|对照" if language == "zh-CN" else r"first experiment|experiment|control",
        "falsification": r"证伪|反驳|失败信号|不支持|支持信号" if language == "zh-CN" else r"falsif|refut|failure signal|support signal",
        "risk": r"风险|失败模式|技术难点" if language == "zh-CN" else r"risk|failure mode|technical challenge",
        "novelty": r"新颖性|暂定|尚未检索|已有工作|novelty|unresolved|未(?:进行|做)?外部(?:文献)?检索" if language == "zh-CN" else r"novelty|provisional|prior work|literature",
    }
    missing = [name for name, pattern in patterns.items() if not re.search(pattern, block, re.IGNORECASE)]
    return compact_length(block) >= minimum_chars and not missing, missing


def candidate_targets(block: str) -> list[str]:
    targets = {
        match.group(1).strip()
        for match in WIKILINK_RE.finditer(block)
        if match.group(1).strip() and not match.group(1).lower().endswith(".pdf")
    }
    return sorted(targets)


def redundant_takeaway_warning(text: str, language: str) -> bool:
    if language == "zh-CN":
        patterns = (r"^###\s*5\s*句话\s*$", r"^###\s*3\s*句话\s*$", r"^###\s*1\s*句话\s*$")
    else:
        patterns = (
            r"^###\s*5\s*Sentences\s*$",
            r"^###\s*3\s*Sentences\s*$",
            r"^###\s*1\s*Sentence\s*$",
        )
    return all(re.search(pattern, text, re.IGNORECASE | re.MULTILINE) for pattern in patterns)


def build_report(args: argparse.Namespace) -> dict[str, object]:
    note_path = Path(args.input).expanduser().resolve()
    raw = note_path.read_bytes()
    text = raw.decode("utf-8")
    frontmatter_match = FRONTMATTER_RE.search(text)
    frontmatter = frontmatter_match.group(1) if frontmatter_match else ""
    blocks = heading_blocks(text)
    names = HEADING_NAMES[args.language]

    missing_headings = [
        heading
        for heading in REQUIRED_HEADINGS[args.language]
        if normalize_heading(heading) not in blocks
    ]
    empty_headings = [
        heading
        for heading in REQUIRED_HEADINGS[args.language]
        if normalize_heading(heading) in blocks
        and compact_length(blocks[normalize_heading(heading)]) < 8
    ]

    plan, plan_load_error = load_plan(args.plan_file)
    plan_required_pass = not args.require_plan or bool(plan)
    plan_issues: list[str] = []
    plan_details: dict[str, object] = {}
    if plan_load_error:
        plan_issues.append(plan_load_error)
    if plan:
        plan_issues, plan_details = validate_plan(
            plan, args.minimum_prior_sources, args.minimum_candidate_links
        )
    elif args.require_plan and not plan_load_error:
        plan_issues.append("plan_file_required")
    plan_contract_pass = plan_required_pass and not plan_issues

    prior_block = block_for(blocks, names["prior"])
    prior_sources = prior_source_tokens(prior_block)
    prior_sources_pass = len(prior_sources) >= args.minimum_prior_sources
    prior_semantics = prior_semantics_pass(prior_block, args.language)
    prior_scope_disclosure = prior_scope_disclosure_pass(prior_block, args.language)

    inference_count = len(INFERENCE_RE.findall(text))
    inference_pass = inference_count >= args.minimum_inferences

    question_block = block_for(blocks, names["question_answer"])
    question_map_pass = question_answer_pass(question_block, args.language)

    followup_block = block_for(blocks, names["followup"])
    followup_depth_pass, followup_missing_elements = followup_pass(
        followup_block, args.language, args.minimum_followup_chars
    )

    candidate_block = block_for(blocks, names["candidates"])
    candidates = candidate_targets(candidate_block)
    candidate_links_pass = len(candidates) >= args.minimum_candidate_links

    material_required = bool(plan_details.get("material_preparation_required", False))
    preparation_block = block_for(blocks, names["preparation"])
    preparation_step_count = len(ORDERED_STEP_RE.findall(preparation_block))
    preparation_pass = not material_required or (
        bool(preparation_block) and preparation_step_count >= 3
    )

    page_links = PDF_PAGE_LINK_RE.findall(text)
    page_links_pass = not args.require_page_links or len(page_links) >= args.minimum_page_links
    draft_pass = not args.require_draft or (bool(frontmatter) and has_draft_status(frontmatter))
    markers_pass = not args.require_user_note_markers or (
        USER_NOTES_START in text and USER_NOTES_END in text
    )

    semantic_failures: list[str] = []
    for passed, code in (
        (prior_sources_pass, "prior_work_source_floor_failed"),
        (prior_semantics, "prior_work_conclusion_or_gap_missing"),
        (prior_scope_disclosure, "prior_work_local_source_disclosure_missing"),
        (inference_pass, "evidence_based_inference_missing"),
        (question_map_pass, "question_evidence_answer_map_incomplete"),
        (followup_depth_pass, "followup_research_idea_too_thin"),
        (candidate_links_pass, "candidate_knowledge_link_floor_failed"),
        (preparation_pass, "material_preparation_steps_missing_or_too_short"),
        (plan_contract_pass, "extended_note_plan_contract_failed"),
    ):
        if not passed:
            semantic_failures.append(code)

    warnings: list[str] = []
    if redundant_takeaway_warning(text, args.language):
        warnings.append("redundant_5_3_1_takeaway_stack")
    if "novel" in text.casefold() and not re.search(
        r"novelty|新颖性|相关工作|prior work|文献", text, re.IGNORECASE
    ):
        warnings.append("novelty_claim_without_visible_calibration")
    if "页码待核对" in text or "page to verify" in text.casefold():
        warnings.append("unresolved_page_review_item")

    passes = all(
        (
            bool(frontmatter),
            not missing_headings,
            not empty_headings,
            page_links_pass,
            draft_pass,
            markers_pass,
            not semantic_failures,
        )
    )

    return {
        "input": str(note_path),
        "language": args.language,
        "passes_research_audit": passes,
        "passes_frontmatter": bool(frontmatter),
        "passes_required_headings": not missing_headings,
        "passes_nonempty_sections": not empty_headings,
        "passes_page_link_floor": page_links_pass,
        "passes_draft_status": draft_pass,
        "passes_user_note_markers": markers_pass,
        "passes_prior_work_sources": prior_sources_pass,
        "passes_prior_work_semantics": prior_semantics,
        "passes_prior_work_local_source_disclosure": prior_scope_disclosure,
        "passes_evidence_based_inference": inference_pass,
        "passes_question_evidence_answer_map": question_map_pass,
        "passes_followup_depth": followup_depth_pass,
        "passes_candidate_link_floor": candidate_links_pass,
        "passes_material_preparation": preparation_pass,
        "passes_extended_plan_contract": plan_contract_pass,
        "missing_headings": missing_headings,
        "empty_headings": empty_headings,
        "semantic_failures": semantic_failures,
        "plan_issues": plan_issues,
        "plan_details": plan_details,
        "prior_source_count": len(prior_sources),
        "prior_source_tokens": prior_sources,
        "inference_count": inference_count,
        "candidate_link_count": len(candidates),
        "candidate_link_targets": candidates,
        "preparation_step_count": preparation_step_count,
        "followup_missing_elements": followup_missing_elements,
        "pdf_page_link_count": len(page_links),
        "note_sha256": hashlib.sha256(raw).hexdigest(),
        "warnings": warnings,
    }


def main() -> int:
    args = parser().parse_args()
    report = build_report(args)
    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        Path(args.output).expanduser().resolve().write_text(serialized, encoding="utf-8")
    print(serialized, end="")
    return 0 if report["passes_research_audit"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

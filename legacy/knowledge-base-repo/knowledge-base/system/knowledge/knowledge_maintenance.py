"""Read-only evidence comparison and structural research-question maintenance.

Relatedness selects material to inspect. It does not establish whether claims
support or contradict each other, and these reports do not approve integration.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
import re
from typing import Any, Callable, Dict, Iterable, List, Optional
from urllib.parse import unquote

import wiki_knowledge as K


ClaimBuilder = Callable[[str, Dict[str, Any]], List[Dict[str, Any]]]
_LOCATION = re.compile(r"^(.+?\.(pdf|md))#(.+)$", re.I)
_SCOPE_WARNING = "关联只用于选取待比较材料；支持、限定、矛盾及纠正关系均待核验，不推定科研新颖性。"


def _link_path(value: Any) -> str:
    raw = K._string(value)
    if raw.startswith("[[") and raw.endswith("]]"):
        raw = raw[2:-2]
    return unquote(re.split(r"\\?\|", raw, maxsplit=1)[0].strip())


def _local_file(vault: Path, relative: str) -> Optional[Path]:
    relative = relative.split("#", 1)[0]
    path = Path(relative)
    if not relative or path.is_absolute() or ".." in path.parts:
        return None
    path = vault / path
    if not path.is_file() or not path.resolve().is_relative_to(vault):
        return None
    return path


def _task(document: K._Document, queued: Dict[str, Any]) -> Dict[str, Any]:
    fields = document.fields
    fallback = {
        "id": fields.get("source_id") or document.path,
        "kind": document.kind,
        "note_path": document.path,
        "title": document.title,
        "paper_identity": fields.get("paper_identity"),
        "doi": fields.get("doi"),
        "parent_key": fields.get("zotero_item"),
        "attachment_key": fields.get("zotero_attachment"),
        "source_path": _link_path(fields.get("source_pdf") or fields.get("source_note")).split("#", 1)[0],
        "sha256": fields.get("source_sha256"),
    }
    fallback.update(queued)
    fallback["note_path"] = document.path
    fallback.setdefault("kind", document.kind)
    conflicts = []
    # A refreshed queue describes the current mirror, whereas the reviewed
    # note's fields bind its statements to the version the human approved.
    reviewed_version = K._string(fields.get("source_sha256"))
    if reviewed_version:
        queued_version = K._string(queued.get("sha256"))
        if queued_version and queued_version.casefold() != reviewed_version.casefold():
            conflicts.append("队列来源版本与笔记审核绑定版本不一致，不能使用新版本复活旧审核声明。")
        fallback["sha256"] = reviewed_version
    reviewed_path = _link_path(fields.get("source_pdf") or fields.get("source_note")).split("#", 1)[0]
    if reviewed_path:
        queued_path = _link_path(queued.get("source_path")).split("#", 1)[0]
        if queued_path and queued_path != reviewed_path:
            conflicts.append("队列来源路径与笔记审核绑定路径不一致，需核验声明的真实出处。")
        fallback["source_path"] = reviewed_path
    fallback["_evidence_conflicts"] = conflicts
    return fallback


def _identity(document: K._Document, task: Dict[str, Any]) -> str:
    if document.kind == "paper":
        fields = dict(document.fields)
        for key in ("paper_identity", "doi", "parent_key", "attachment_key"):
            if task.get(key):
                fields[key] = task[key]
        return K._paper_identity(fields, document.path)
    if K._string(task.get("source_identity")):
        return K._string(task["source_identity"])
    source_id = K._string(document.fields.get("source_id"))
    if source_id.startswith("experiment:") and source_id.count(":") >= 2:
        return source_id.rsplit(":", 1)[0]
    source = K._string(task.get("source_path"))
    return "experiment:" + source if source else "note:" + document.path


def _evidence_check(vault: Path, document: K._Document, task: Dict[str, Any],
                    claims: List[Dict[str, Any]]) -> tuple[bool, List[str]]:
    warnings = list(task.get("_evidence_conflicts", []))
    current = not warnings
    if not claims:
        return False, [*warnings, "未找到带原始来源定位的可验证声明。"]
    source_path = K._string(task.get("source_path"))
    recorded_version = K._string(task.get("sha256"))
    if not recorded_version:
        current = False
        warnings.append("来源版本未记录，不能确认原始证据为当前版本。")
    else:
        source = _local_file(vault, source_path)
        if source is None:
            current = False
            warnings.append("记录的原始来源文件缺失或不在知识库内。")
        elif hashlib.sha256(source.read_bytes()).hexdigest() != recorded_version.casefold():
            current = False
            warnings.append("原始来源内容已变化，记录的来源版本已过期。")
    for claim in claims:
        evidence = claim.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            current = False
            warnings.append(f"声明 {claim.get('claim_id', '')} 缺少原始证据定位。")
            continue
        for link in evidence:
            located = _LOCATION.match(link) if isinstance(link, str) else None
            valid = bool(located)
            if located:
                filename, extension, locator = located.groups()
                if document.kind == "paper":
                    valid = extension.casefold() == "pdf" and bool(re.fullmatch(r"page=[1-9]\d*", locator))
                else:
                    valid = extension.casefold() == "md" and bool(locator.strip())
                valid = valid and _local_file(vault, filename) is not None
            if not valid:
                current = False
                warnings.append(f"声明 {claim.get('claim_id', '')} 的原始证据文件或定位不可用：{link}")
    return current, list(dict.fromkeys(warnings))


def _source(vault: Path, document: K._Document, claim_builder: ClaimBuilder,
            queue: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    task = _task(document, queue.get(document.path, {}))
    claims = claim_builder(document.text, task)
    if not isinstance(claims, list) or any(not isinstance(claim, dict) for claim in claims):
        raise ValueError("claim_builder must return a list of claim objects")
    current, warnings = _evidence_check(vault, document, task, claims)
    if not document.reviewed:
        warnings.insert(0, "来源笔记未获有效人工审核，或审核已过期。")
    return {
        "note_path": document.path, "title": document.title, "kind": document.kind,
        "identity": _identity(document, task), "status": document.status,
        "reviewed": document.reviewed, "evidence_current": current,
        "source_path": K._string(task.get("source_path")),
        "source_version": K._string(task.get("sha256")).casefold(),
        "claims": claims, "warnings": warnings,
    }


def _queue(items: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return {str(item.get("note_path")): dict(item) for item in items if item.get("note_path")}


def _flat_claim(source: Dict[str, Any], claim: Dict[str, Any]) -> Dict[str, Any]:
    return {**claim, "note_path": source["note_path"], "source_title": source["title"],
            "kind": source["kind"], "identity": source["identity"],
            "status": source["status"], "reviewed": source["reviewed"],
            "evidence_current": source["evidence_current"],
            "source_path": source["source_path"], "source_version": source["source_version"],
            "relationship": "待核验"}


def collect_comparison(vault: Path, question: str, note_path: Optional[str],
                       claim_builder: ClaimBuilder, queue_items: Iterable[Dict[str, Any]] = (),
                       limit: int = 6) -> Dict[str, Any]:
    """Return original, located statements from a bounded set of related sources."""
    vault = Path(vault).resolve()
    limit = max(1, int(limit))
    documents, document_warnings = K._documents(vault)
    by_path = {document.path: document for document in documents
               if document.kind in {"paper", "experiment"}}
    anchor = None
    warnings = list(document_warnings)
    if note_path:
        supplied = Path(note_path)
        if supplied.is_absolute():
            try:
                note_path = supplied.resolve().relative_to(vault).as_posix()
            except ValueError:
                note_path = ""
        anchor = by_path.get(str(note_path))
        if anchor is None:
            warnings.append("指定的对比来源不在可用论文或实验笔记中。")
    context = K.knowledge_context(vault, question, anchor.path if anchor else None,
                                  limit=max(limit * 4, limit), total_chars=0)
    selected = [anchor] if anchor else []
    selected.extend(by_path[result["note_path"]] for result in context["results"]
                    if result["note_path"] in by_path)
    queue = _queue(queue_items)
    sources, seen = [], set()
    for document in selected:
        identity = _identity(document, _task(document, queue.get(document.path, {})))
        if identity in seen:
            continue
        seen.add(identity)
        sources.append(_source(vault, document, claim_builder, queue))
        if len(sources) >= limit:
            break
    eligible, draft = [], []
    eligible_sources = 0
    for source in sources:
        usable = source["reviewed"] and source["evidence_current"] and bool(source["claims"])
        eligible_sources += int(usable)
        destination = eligible if usable else draft
        destination.extend(_flat_claim(source, claim) for claim in source["claims"])
        warnings.extend(f"{source['title']}：{warning}" for warning in source["warnings"])
    if eligible_sources < 2:
        warnings.append("独立、有效审核且原始证据当前的来源不足两份，不能据此进行跨来源规范知识整合。")
    warnings.append(_SCOPE_WARNING)
    return {
        "question": question, "anchor_note": anchor.path if anchor else None,
        "sources": sources, "eligible_claims": eligible, "draft_claims": draft,
        "eligible_source_count": eligible_sources, "can_integrate": eligible_sources >= 2,
        "warnings": list(dict.fromkeys(warnings)),
    }


def _cell(value: Any) -> str:
    return re.sub(r"(?<!\\)\|", r"\\|", str(value)).replace("\n", "<br>")


def _evidence_links(evidence: Any) -> str:
    if not isinstance(evidence, list):
        return "未记录"
    return " ".join(f"[[{item}]]" for item in evidence)


def comparison_markdown(payload: Dict[str, Any]) -> str:
    lines = ["# 跨来源证据对比", "", str(payload.get("question", "")), "",
             f"独立可用来源：{payload.get('eligible_source_count', 0)}。",
             "达到来源门槛仍需逐条核验条件与关系，并经过现有人工审核及整合流程。", "",
             "| 来源笔记声明（保留条件） | 原始定位 | 来源笔记 | 审核与来源状态 | 关系 |",
             "|---|---|---|---|---|"]
    for source in payload.get("sources", []):
        state = ("审核有效" if source["reviewed"] else "审核无效或未审核")
        state += "；" + ("原始证据当前" if source["evidence_current"] else "原始证据待复核")
        for claim in source.get("claims", []):
            cells = [claim.get("statement_with_conditions", ""), _evidence_links(claim.get("evidence")),
                     f"[[{source['note_path']}|{source['title']}]]", state, "待核验"]
            lines.append("| " + " | ".join(_cell(value) for value in cells) + " |")
    if not payload.get("sources"):
        lines.extend(["", "本次未找到相关的带来源定位笔记。"])
    lines.extend(["", "## 待核验事项", ""])
    lines.extend("- " + warning for warning in payload.get("warnings", []))
    return "\n".join(lines) + "\n"


def _reference_documents(document: K._Document, documents: List[K._Document]) -> tuple[List[K._Document], List[Dict[str, Any]]]:
    aliases: Dict[str, List[K._Document]] = {}
    for source in documents:
        if source.kind not in {"paper", "experiment"}:
            continue
        for alias in {source.path, source.path.removesuffix(".md"), Path(source.path).stem,
                      source.title, *K._strings(source.fields.get("aliases"))}:
            matches = aliases.setdefault(alias.casefold(), [])
            if source not in matches:
                matches.append(source)
    resolved, issues, seen = [], [], set()
    for link in document.links:
        choices = aliases.get(link.casefold(), [])
        if len(choices) == 1:
            if choices[0].path not in seen:
                seen.add(choices[0].path)
                resolved.append(choices[0])
        elif len(choices) > 1:
            issues.append({"kind": "ambiguous_source_link", "target": link,
                           "message": "来源链接重名，需人工确认对应笔记。"})
        elif link.startswith(("wiki/papers/", "wiki/experiments/")):
            issues.append({"kind": "missing_source_note", "target": link,
                           "message": "引用的来源笔记缺失或不属于可用主笔记。"})
    return resolved, issues


def _has_answer(document: K._Document) -> bool:
    status = K._string(document.fields.get("question_status") or document.fields.get("status"))
    if status.casefold() in {"answered", "resolved", "已回答", "已解决"}:
        return True
    answer = re.search(r"(?ms)^#{1,6}\s+(?:当前答案|回答|答案|Answer)\s*\n(.*?)(?=^#{1,6} |\Z)", document.text)
    if not answer:
        return False
    text = answer.group(1).strip()
    return bool(text) and text not in {"待回答", "暂无", "未解决", "待补充"}


def question_maintenance(vault: Path, claim_builder: ClaimBuilder,
                         queue_items: Iterable[Dict[str, Any]] = ()) -> Dict[str, Any]:
    vault = Path(vault).resolve()
    documents, warnings = K._documents(vault)
    queue_items = list(queue_items)
    queue = _queue(queue_items)
    questions = []
    for document in documents:
        if not document.path.startswith("wiki/questions/"):
            continue
        references, issues = _reference_documents(document, documents)
        sources = [_source(vault, source, claim_builder, queue) for source in references]
        for source in sources:
            if not source["reviewed"]:
                issues.append({"kind": "source_review_invalid", "source_note": source["note_path"],
                               "message": "引用来源的人工审核无效、过期或尚未完成。"})
            if not source["evidence_current"]:
                issues.append({"kind": "source_evidence_unavailable", "source_note": source["note_path"],
                               "message": "引用来源的原始证据版本或定位需要复核。",
                               "warnings": source["warnings"]})
        original_links = [link for link in document.links if link.startswith(
            ("sources/", "extracts/", "笔记/实验笔记/"))]
        for link in original_links:
            if _local_file(vault, link) is None:
                issues.append({"kind": "missing_original_evidence", "target": link,
                               "message": "问题页面引用的原始证据文件缺失。"})
        if _has_answer(document) and not sources and not original_links:
            issues.append({"kind": "answer_without_source", "message": "现有回答未发现来源引用，需人工复核。"})
        comparison = collect_comparison(vault, document.title + "\n" + document.text,
                                        None, claim_builder, queue_items, limit=6)
        current_ids = set(K.CLAIM_MARKER.findall(document.text))
        new_claims = [claim for claim in comparison["eligible_claims"]
                      if claim.get("claim_id") not in current_ids]
        if new_claims:
            issues.append({"kind": "related_reviewed_claims", "claim_count": len(new_claims),
                           "message": "发现尚未记录在当前问题页的相关已审核声明；关系与条件仍待核验。"})
        questions.append({
            "note_path": document.path, "title": document.title,
            "status": K._string(document.fields.get("question_status")) or document.status,
            "referenced_sources": sources, "existing_claim_ids": sorted(current_ids),
            "new_related_claims": new_claims, "issues": issues,
        })
    warnings.append("这里只检查本地引用、审核与声明覆盖；不证明科研缺口，不自动补答案、修改问题状态或关闭问题。")
    return {"questions": questions, "question_count": len(questions), "warnings": warnings}


def question_maintenance_markdown(payload: Dict[str, Any]) -> str:
    lines = ["# 研究问题维护报告", "", f"检查 {payload.get('question_count', 0)} 个真实问题页面。", ""]
    for question in payload.get("questions", []):
        lines.extend([f"## [[{question['note_path']}|{question['title']}]]", "",
                      "当前状态：" + question["status"] + "（保留人类记录）。", ""])
        if not question["issues"]:
            lines.append("本次未发现需要报告的结构性整理事项。")
        for issue in question["issues"]:
            target = issue.get("source_note") or issue.get("target")
            lines.append("- " + issue["message"] + (f" [[{target}]]" if target else ""))
            lines.extend("  - " + warning for warning in issue.get("warnings", []))
        if question["new_related_claims"]:
            lines.extend(["", "### 新相关声明（关系待核验）", "",
                          "| 来源笔记声明（保留条件） | 原始定位 | 已审核来源 |", "|---|---|---|"])
            for claim in question["new_related_claims"]:
                cells = [claim.get("statement_with_conditions", ""), _evidence_links(claim.get("evidence")),
                         f"[[{claim['note_path']}|{claim['source_title']}]]"]
                lines.append("| " + " | ".join(_cell(value) for value in cells) + " |")
        lines.append("")
    lines.extend(["## 使用边界", ""])
    lines.extend("- " + warning for warning in payload.get("warnings", []))
    return "\n".join(lines) + "\n"

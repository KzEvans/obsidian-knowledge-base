"""Read-only local wiki retrieval and graph clues, using the standard library.

Text and links are source data. Scores describe retrieval relevance, never
scientific support or confidence. No application server or model is invoked.
"""
from __future__ import annotations

from collections import defaultdict
import csv
import hashlib
import json
import math
import posixpath
from pathlib import Path
import re
from typing import Any, Optional
import unicodedata
from urllib.parse import unquote, urlparse


CANONICAL_DIRS = {"concepts", "materials", "methods", "phenomena", "projects", "questions", "synthesis"}
ENTITY_FIELDS = ("concepts", "materials", "methods", "phenomena", "entities", "keywords", "tags")
REVIEW_FIELDS = "status|reviewed|reviewed_at|reviewed_with|reviewed_content_sha256|review_warnings_accepted|integrated_at"
WIKI_LINK = re.compile(r"\[\[([^\]\n]+)\]\]")
PDF_LINK = re.compile(r"\[\[[^\]\n]+\.pdf#page=\d+(?:\\?\|[^\]\n]*)?\]\]", re.IGNORECASE)
MARKDOWN_LINK = re.compile(r"(?<!!)\[[^\]\n]*\]\(([^)\n]+)\)")
CLAIM_MARKER = re.compile(r"<!--\s*kb-claim:([^\s>]+)\s*-->")
STOP_WORDS = {"a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "what", "which", "with", "什么", "如何", "是否", "为什么", "怎么"}
CONCEPT_ALIASES = "system/knowledge/concept-aliases.json"
# Independently adapted retrieval design from nashsu/llm_wiki at
# 48fd970e206a02a6d2028d1dbfc41b7a0345bf0b: search.rs (phrase matching,
# bounded one-hop expansion), graph-relevance.ts (Adamic-Adar).
# These are relevance signals, never evidence-confidence scores.
FILENAME_EXACT_BONUS = 48.0
TITLE_EXACT_BONUS = 32.0
TITLE_PHRASE_BONUS = 20.0
BODY_PHRASE_WEIGHT = 4.0
MAX_BODY_PHRASE_HITS = 3
MAX_QUERY_GRAPH_SEEDS = 4
MAX_QUERY_GRAPH_RESULTS = 2


def _scalar(raw: str) -> Any:
    raw = raw.strip()
    if not raw:
        return ""
    if raw.startswith('"') and raw.endswith('"'):
        try:
            value = json.loads(raw)
            return value if isinstance(value, str) else raw
        except ValueError:
            return raw[1:-1]
    if raw.startswith("'") and raw.endswith("'"):
        return raw[1:-1].replace("''", "'")
    raw = re.split(r"\s+#", raw, maxsplit=1)[0].strip()
    if raw.casefold() in {"null", "~"}:
        return None
    if raw.casefold() in {"true", "false"}:
        return raw.casefold() == "true"
    return raw


def _frontmatter(text: str) -> dict[str, Any]:
    """Only top-level scalars and simple scalar lists; no YAML evaluation."""
    match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", text, re.DOTALL)
    if not match:
        return {}
    fields: dict[str, Any] = {}
    list_key = None
    for line in match.group(1).splitlines():
        item = re.match(r"^\s*-\s+(.+)$", line)
        if item and list_key:
            value = _scalar(item.group(1))
            if isinstance(value, (str, bool)) or value is None:
                fields[list_key].append(value)
            continue
        scalar = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$", line)
        if not scalar:
            continue
        key, raw = scalar.groups()
        list_key = None
        if not raw.strip():
            fields[key] = []
            list_key = key
        elif raw.strip().startswith("[") and raw.strip().endswith("]"):
            try:
                values = json.loads(raw)
            except ValueError:
                try:
                    values = [_scalar(value) for value in next(csv.reader([raw.strip()[1:-1]], skipinitialspace=True))]
                except csv.Error:
                    values = []
            fields[key] = [value for value in values if isinstance(value, (str, bool)) or value is None] if isinstance(values, list) else []
        else:
            fields[key] = _scalar(raw)
    return fields


def _string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _strings(value: Any) -> list[str]:
    values = value if isinstance(value, list) else [value]
    return [item.strip() for item in values if isinstance(item, str) and item.strip()]


def _true(value: Any) -> bool:
    return value is True or (isinstance(value, str) and value.casefold() == "true")


def _legacy_review_hash(text: str) -> str:
    text = text.replace("\r\n", "\n")
    match = re.match(r"\A---\n(.*?)\n---", text, re.DOTALL)
    if match:
        fields = re.sub(rf"(?m)^(?:{REVIEW_FIELDS}):[^\n]*\n?", "", match.group(1))
        text = "---\n" + fields.rstrip("\n") + "\n---" + text[match.end():]
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _without_question_answer_section(text: str) -> str:
    # Mirrors without_question_answer_section in run_pipeline.py.
    lines = text.split("\n")
    start = next((index for index, line in enumerate(lines) if line.strip() == "# 提问"), None)
    if start is not None:
        end = next((index for index in range(start + 1, len(lines)) if re.match(r"#\s+", lines[index])), len(lines))
        head = "\n".join(lines[:start]).rstrip()
        tail = "\n".join(lines[end:]).lstrip()
        text = f"{head}\n\n{tail}" if tail else head
    return text.rstrip() + "\n"


def _review_hash(text: str) -> str:
    return _legacy_review_hash(_without_question_answer_section(text.replace("\r\n", "\n")))


def _review_hash_matches(stored: str, text: str) -> bool:
    return bool(stored) and stored in {_review_hash(text), _legacy_review_hash(text)}


def _approved(text: str, fields: dict[str, Any]) -> bool:
    if not _true(fields.get("reviewed")) or fields.get("status") not in {"reviewed", "integrated"}:
        return False
    if not _review_hash_matches(_string(fields.get("reviewed_content_sha256")), text):
        return False
    review = re.search(r"(?ms)^## (?:人工复核|Human Review)\s*\n(.*?)(?=^#{1,2} |\Z)", text)
    if review and re.search(r"(?m)^\s*[-*+] \[ \]", review.group(1)):
        return False
    if (fields.get("validation_status") != "passed" or _strings(fields.get("validation_warnings"))) and not _true(fields.get("review_warnings_accepted")):
        return False
    return True


def _doi(value: str) -> str:
    value = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", value.strip(), flags=re.IGNORECASE)
    return value.casefold()


def _paper_identity(fields: dict[str, Any], note_path: str) -> str:
    doi = _string(fields.get("doi"))
    recorded = _string(fields.get("paper_identity"))
    if doi and re.match(r"^10\.\d{4,9}/\S+$", _doi(doi)):
        return "doi:" + _doi(doi)
    if recorded.casefold().startswith("doi:") and re.match(r"^10\.\d{4,9}/\S+$", _doi(recorded)):
        return "doi:" + _doi(recorded)
    if recorded and not recorded.casefold().startswith("doi:") and recorded.casefold() not in {"unknown", "zotero:unknown"}:
        return recorded
    for name in ("zotero_item", "parent_key", "zotero_attachment", "attachment_key"):
        if _string(fields.get(name)):
            return "zotero:" + _string(fields[name])
    source_id = _string(fields.get("source_id"))
    parts = source_id.split(":")
    if len(parts) >= 2 and parts[0] == "paper":
        return "zotero:" + parts[1]
    return "note:" + note_path


def _tokens(value: str) -> set[str]:
    tokens = {word.casefold() for word in re.findall(r"[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*", value)}
    for run in re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]+", value):
        if len(run) <= 32:
            tokens.add(run)
        tokens.update(run[index:index + 2] for index in range(len(run) - 1))
    return tokens - STOP_WORDS


def _markdown_body(text: str) -> str:
    return re.sub(r"\A---\r?\n.*?\r?\n---(?:\r?\n|$)", "", text, count=1, flags=re.DOTALL)


def _wiki_target(value: str) -> str:
    return unquote(value.split("|", 1)[0].rstrip("\\").split("#", 1)[0].strip())


def _links(text: str) -> list[str]:
    links = [_wiki_target(match.group(1)) for match in WIKI_LINK.finditer(text)]
    for match in MARKDOWN_LINK.finditer(text):
        raw = match.group(1).strip().strip("<>")
        if not urlparse(raw).scheme and not raw.startswith("#"):
            links.append(unquote(raw.split("#", 1)[0]))
    return list(dict.fromkeys(link for link in links if link))


class _Document:
    def __init__(self, path: Path, vault: Path, text: str):
        self.path = path.relative_to(vault).as_posix()
        self.text = text
        self.fields = _frontmatter(text)
        top_heading = re.search(r"(?m)^#\s+(.+)$", text)
        self.title = (_string(self.fields.get("display_title")) or _string(self.fields.get("title"))
                      or (top_heading.group(1).strip() if top_heading else path.stem))
        self.status = _string(self.fields.get("status")) or "unknown"
        self.reviewed = _approved(text, self.fields)
        part = self.path.split("/")[1] if "/" in self.path else ""
        self.kind = "paper" if part == "papers" else "experiment" if part == "experiments" else "canonical" if part in CANONICAL_DIRS else "note"
        self.paper_identity = _paper_identity(self.fields, self.path) if self.kind == "paper" else ""
        self.source_pdf = _string(self.fields.get("source_pdf"))
        self.validation_warnings = _strings(self.fields.get("validation_warnings"))
        self.links = _links(text)
        self.entities = {item for name in ENTITY_FIELDS for item in _strings(self.fields.get(name))}
        self.entities.update(link.removesuffix(".md").split("/")[-1] for link in self.links
                             if not Path(link).suffix or Path(link).suffix.casefold() == ".md")
        self.title_tokens = _tokens(self.title + " " + path.stem + " " + " ".join(_strings(self.fields.get("aliases"))))
        self.entity_tokens = _tokens(" ".join(self.entities))
        self.body_tokens = _tokens(_markdown_body(text))
        self.neighbors: set[str] = set()
        self.sources = {link for link in self.links if link.casefold().endswith(".pdf")}
        if self.source_pdf:
            self.sources.add(_wiki_target(self.source_pdf.strip("[]")))
        self.missing_entities: set[str] = set()


def _documents(vault: Path) -> tuple[list[_Document], list[str]]:
    vault = vault.resolve()
    documents = []
    warnings = []
    wiki = vault / "wiki"
    if not wiki.is_dir():
        return [], ["未找到 wiki/ 目录。"]
    for path in sorted(wiki.rglob("*.md")):
        relative = path.relative_to(vault)
        if path.is_symlink() or any(part in {"images", "close-reading", "runtime"} for part in relative.parts):
            continue
        if path.stem.casefold() in {"index", "readme"} or path.stem.endswith("索引"):
            continue
        try:
            documents.append(_Document(path, vault, path.read_text(encoding="utf-8")))
        except (OSError, UnicodeError) as error:
            warnings.append(f"无法读取 {relative.as_posix()}: {type(error).__name__}")
    return documents, warnings


def _alias_key(value: str) -> str:
    return " ".join(value.split()).casefold()


def _form_key(value: str) -> str:
    """For maintenance clues only; this never establishes an equivalence."""
    return re.sub(r"[\s\-‐‑‒–—]+", "", unicodedata.normalize("NFKC", value).casefold())


def _canonical_target(raw: Any) -> Optional[str]:
    if not isinstance(raw, str) or not raw.strip():
        return None
    target = posixpath.normpath(raw.strip())
    parts = Path(target).parts
    if (len(parts) < 3 or parts[0] != "wiki" or parts[1] not in CANONICAL_DIRS
            or Path(target).suffix != ".md" or any(part in {"images", "close-reading", "runtime"} for part in parts)):
        return None
    return target


def _concept_registry(vault: Path, documents: list[_Document]) -> dict[str, Any]:
    """Combine explicit canonical aliases and a read-only user mapping file."""
    canonical_docs = {document.path: document for document in documents if document.kind == "canonical"}
    mappings: dict[str, dict[str, Any]] = {}
    warnings = []
    def register(target: str, aliases: list[str], origin: str) -> None:
        document = canonical_docs.get(target)
        entry = mappings.setdefault(target, {
            "canonical": target, "title": document.title if document else Path(target).stem,
            "aliases": set(), "origins": set(), "exists": (vault / target).is_file(),
            "available": document is not None,
        })
        entry["aliases"].update(aliases)
        entry["origins"].add(origin)
    for document in canonical_docs.values():
        register(document.path, _strings(document.fields.get("aliases")), "frontmatter")
    path = vault / CONCEPT_ALIASES
    if path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeError, ValueError) as error:
            warnings.append(f"{CONCEPT_ALIASES} 无法解析（{type(error).__name__}）；用户映射未生效。")
        else:
            if (not isinstance(payload, dict) or type(payload.get("version")) is not int
                    or payload.get("version") != 1 or not isinstance(payload.get("concepts"), list)):
                warnings.append(f"{CONCEPT_ALIASES} 格式无效：需要 version: 1 和 concepts 数组；用户映射未生效。")
            else:
                for index, item in enumerate(payload["concepts"], 1):
                    target = _canonical_target(item.get("canonical")) if isinstance(item, dict) else None
                    aliases = item.get("aliases") if isinstance(item, dict) else None
                    if target is None or not isinstance(aliases, list) or any(not isinstance(alias, str) or not alias.strip() for alias in aliases):
                        warnings.append(f"{CONCEPT_ALIASES} 第 {index} 项无效：目标必须位于 canonical 七目录，aliases 必须是非空字符串数组；此项未生效。")
                        continue
                    register(target, [alias.strip() for alias in aliases], CONCEPT_ALIASES)
    lookup: dict[str, set[str]] = defaultdict(set)
    spellings: dict[str, set[str]] = defaultdict(set)
    family: dict[str, set[str]] = {}
    rows = []
    missing = []
    for target, item in sorted(mappings.items()):
        names = {target, target.removesuffix(".md"), Path(target).stem, item["title"], *item["aliases"]}
        family[target] = names
        for name in names:
            lookup[_alias_key(name)].add(target)
            spellings[_alias_key(name)].add(name)
        row = {**item, "aliases": sorted(item["aliases"]), "origins": sorted(item["origins"])}
        rows.append(row)
        if not item["available"]:
            missing.append({"canonical": target, "aliases": sorted(item["aliases"]),
                            "reason": "目标不存在，待创建或核对" if not item["exists"] else "目标未被索引（索引页、排除目录或不可读），待核对"})
    ambiguous = [{"alias": sorted(spellings[key])[0], "spellings": sorted(spellings[key]), "canonical_targets": sorted(targets)}
                 for key, targets in sorted(lookup.items()) if len(targets) > 1 and not key.startswith("wiki/")]
    return {"mappings": rows, "lookup": lookup, "spellings": spellings, "family": family,
            "available": set(canonical_docs), "ambiguous_aliases": ambiguous, "missing_targets": missing,
            "warnings": warnings}


def _apply_concepts(documents: list[_Document], registry: dict[str, Any]) -> None:
    for document in documents:
        entities = set()
        expanded_names = set()
        for entity in document.entities:
            target_name = _wiki_target(entity.strip("[]"))
            targets = registry["lookup"].get(_alias_key(target_name), set())
            if len(targets) > 1:
                continue  # An ambiguous name must not become a shared resolved entity.
            if len(targets) == 1:
                target = next(iter(targets))
                if target in registry["available"]:
                    entities.add(target)
                    expanded_names.update(_unambiguous_names(registry, target))
                    continue
            entities.add(entity)
        if document.kind == "canonical":
            entities.add(document.path)
            expanded_names.update(_unambiguous_names(registry, document.path))
        document.entities = entities
        document.entity_tokens = _tokens(" ".join(entities | expanded_names))


def _unambiguous_names(registry: dict[str, Any], target: str) -> set[str]:
    return {name for name in registry["family"].get(target, set()) if not name.startswith("wiki/")
            and len(registry["lookup"].get(_alias_key(name), set())) == 1}


def _query_concepts(question: str, registry: dict[str, Any]) -> tuple[set[str], list[dict[str, Any]], list[str]]:
    tokens = _tokens(question)
    original_tokens = set(tokens)
    reasons = []
    warnings = []
    question_key = _alias_key(question)
    expanded = set()
    for alias, targets in sorted(registry["lookup"].items()):
        if alias.startswith("wiki/") or not alias:
            continue
        pattern = re.escape(alias)
        if alias[0].isascii() and alias[0].isalnum():
            pattern = r"(?<![a-z0-9])" + pattern
        if alias[-1].isascii() and alias[-1].isalnum():
            pattern += r"(?![a-z0-9])"
        if not re.search(pattern, question_key):
            continue
        if len(targets) > 1:
            warnings.append(f"概念别名“{alias}”有多个目标，未展开：" + "、".join(sorted(targets)))
            continue
        target = next(iter(targets))
        if target not in registry["available"]:
            warnings.append(f"概念别名“{alias}”指向未可用目标 {target}，待创建或核对，未展开。")
            continue
        if target not in expanded:
            family_tokens = _tokens(" ".join(_unambiguous_names(registry, target)))
            tokens.update(family_tokens)
            reasons.append({"target": target, "tokens": family_tokens - original_tokens,
                            "reason": f"显式概念别名展开：{alias} → {target}"})
            expanded.add(target)
    return tokens, reasons, warnings


def _graph(vault: Path, documents: list[_Document], registry: Optional[dict[str, Any]] = None) -> tuple[dict[str, str], dict[str, list[dict[str, str]]]]:
    aliases: dict[str, set[str]] = defaultdict(set)
    by_path = {document.path: document for document in documents}
    for document in documents:
        for alias in (document.path, document.path.removesuffix(".md"), Path(document.path).stem, document.title, *_strings(document.fields.get("aliases"))):
            aliases[_alias_key(alias)].add(document.path)
    if registry:
        for alias, targets in registry["lookup"].items():
            aliases[alias].update(targets)
    representatives = {document.path: document.path for document in documents}
    papers: dict[str, list[_Document]] = defaultdict(list)
    for document in documents:
        if document.kind == "paper":
            papers[document.paper_identity].append(document)
    for group in papers.values():
        chosen = sorted(group, key=lambda document: (not document.reviewed, document.status != "integrated", document.path))[0]
        for document in group:
            representatives[document.path] = chosen.path
    clues: dict[str, list[dict[str, str]]] = {"broken_links": [], "ambiguous_links": []}
    for document in documents:
        for link in document.links:
            normalized = posixpath.normpath(link)
            relative = posixpath.normpath(posixpath.join(posixpath.dirname(document.path), link))
            candidates = set()
            for candidate in (normalized, relative, normalized.removesuffix(".md"), relative.removesuffix(".md")):
                candidates.update(aliases.get(_alias_key(candidate), set()))
            candidate_reps = {representatives.get(path, path) for path in candidates}
            if len(candidate_reps) == 1:
                target = candidate_reps.pop()
                if target in by_path:
                    if target != representatives[document.path]:
                        document.neighbors.add(target)
                    if by_path[target].kind == "paper":
                        document.sources.add(by_path[target].paper_identity)
                    continue
                clues["broken_links"].append({"note_path": document.path, "target": link, "mapped_target": target})
                document.missing_entities.add(Path(target).stem)
                continue
            if len(candidate_reps) > 1:
                clues["ambiguous_links"].append({"note_path": document.path, "target": link})
                continue
            paths = [vault / normalized, vault / relative]
            if not Path(link).suffix:
                paths.extend([vault / (normalized + ".md"), vault / (relative + ".md")])
            exists = False
            for path in paths:
                try:
                    if path.resolve().is_relative_to(vault.resolve()) and path.is_file():
                        exists = True
                        break
                except OSError:
                    continue
            if exists:
                continue
            clues["broken_links"].append({"note_path": document.path, "target": link})
            if not Path(link).suffix or Path(link).suffix.casefold() == ".md":
                document.missing_entities.add(link.removesuffix(".md").split("/")[-1])
    return representatives, clues


def _neighbor_index(documents: list[_Document]) -> dict[str, set[str]]:
    """Undirected adjacency of resolved links between the admitted documents."""
    neighbors = {document.path: set() for document in documents}
    for document in documents:
        for target in document.neighbors:
            if target in neighbors and target != document.path:
                neighbors[document.path].add(target)
                neighbors[target].add(document.path)
    return neighbors


def _relationships(left: _Document, right: _Document,
                   neighbors: Optional[dict[str, set[str]]] = None) -> tuple[float, list[str]]:
    score = 0.0
    reasons = []
    if left.path in right.neighbors or right.path in left.neighbors:
        score += 12
        reasons.append("直接笔记链接")
    for common, weight, label in (
        (left.entities & right.entities, 4, "共享实体"),
        (left.sources & right.sources, 3, "共享来源定位"),
    ):
        if common:
            score += weight * min(3, len(common))
            reasons.append(label + "：" + "、".join(sorted(common)[:3]))
    adjacency = neighbors if neighbors is not None else {left.path: left.neighbors, right.path: right.neighbors}
    common = adjacency.get(left.path, set()) & adjacency.get(right.path, set())
    if common:
        adamic_adar = sum(1.0 / math.log(max(2, len(adjacency.get(path, set())))) for path in common)
        score += 2.0 * adamic_adar
        reasons.append("共同关联页面（Adamic–Adar 度数降权）：" + "、".join(sorted(common)[:3]))
    return score, reasons


def _query_phrase(value: str) -> str:
    return " ".join(value.strip(" \t\r\n?!？！，,。.\"").split()).casefold()


def _phrase_pattern(phrase: str) -> str:
    pattern = re.escape(phrase)
    if phrase and phrase[0].isascii() and phrase[0].isalnum():
        pattern = r"(?<![a-z0-9])" + pattern
    if phrase and phrase[-1].isascii() and phrase[-1].isalnum():
        pattern += r"(?![a-z0-9])"
    return pattern


def _query_score(document: _Document, tokens: set[str], phrase: str) -> tuple[float, list[str]]:
    if not tokens:
        return 0.0, []
    score = 0.0
    reasons = []
    for shared, weight, label in (
        (tokens & document.title_tokens, 6, "标题匹配"),
        (tokens & document.entity_tokens, 4, "实体/关键词匹配"),
        (tokens & document.body_tokens, 1, "正文匹配"),
    ):
        if shared:
            score += weight * len(shared)
            reasons.append(label + "：" + "、".join(sorted(shared)[:6]))
    if not phrase:
        return score, reasons
    if phrase in {Path(document.path).stem.casefold(), Path(document.path).name.casefold()}:
        score += FILENAME_EXACT_BONUS
        reasons.append("文件名完整匹配")
    titles = {_query_phrase(document.title), _query_phrase(_string(document.fields.get("title")))} - {""}
    if phrase in titles:
        score += TITLE_EXACT_BONUS
        reasons.append("完整标题匹配")
    elif any(re.search(_phrase_pattern(phrase), title) for title in titles):
        score += TITLE_PHRASE_BONUS
        reasons.append("标题短语匹配")
    phrase_hits = min(MAX_BODY_PHRASE_HITS, len(re.findall(_phrase_pattern(phrase), _alias_key(_markdown_body(document.text)))))
    if phrase_hits:
        score += BODY_PHRASE_WEIGHT * phrase_hits
        reasons.append(f"正文短语匹配（最多计 {MAX_BODY_PHRASE_HITS} 次）：{phrase}")
    return score, reasons


def _graph_expansion(direct: list[tuple[float, _Document, list[str]]], eligible: dict[str, _Document],
                     neighbors: dict[str, set[str]], limit: int, excluded: set[str]) -> list[tuple[float, _Document, list[str]]]:
    """Small one-hop supplement, seeded only by direct query matches."""
    quota = min(MAX_QUERY_GRAPH_RESULTS, max(0, limit) // 4)
    if not quota or not direct:
        return []
    seeds = sorted(direct, key=lambda item: (-item[0], item[1].path))[:min(MAX_QUERY_GRAPH_SEEDS, limit)]
    seed_paths = {document.path for _, document, _ in seeds}
    scores: dict[str, float] = defaultdict(float)
    supports: dict[str, list[str]] = defaultdict(list)
    for rank, (_, seed, _) in enumerate(seeds, 1):
        for path in sorted(neighbors.get(seed.path, set())):
            if path in seed_paths or path in excluded or path not in eligible:
                continue
            relation, _ = _relationships(seed, eligible[path], neighbors)
            scores[path] += relation / (12.0 * rank)
            supports[path].append(seed.path)
    candidates = sorted(scores, key=lambda path: (-scores[path], path))[:quota]
    return [(scores[path], eligible[path], ["直接检索命中的一跳图扩展：" + "、".join(supports[path])])
            for path in candidates]


def _chunks(document: _Document) -> list[dict[str, str]]:
    text = _markdown_body(document.text)
    heading = document.title
    chunks = []
    paragraph = []
    def flush() -> None:
        if paragraph:
            content = "\n".join(paragraph).strip()
            if content:
                chunks.append({"heading": heading, "text": content})
            paragraph.clear()
    for line in text.splitlines():
        match = re.match(r"^#{1,6}\s+(.+)$", line)
        if match:
            flush()
            heading = match.group(1).strip()
        elif not line.strip():
            flush()
        else:
            paragraph.append(line)
    flush()
    return chunks


def _excerpt(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    citations = list(dict.fromkeys(match.group(0) for match in PDF_LINK.finditer(text)))
    suffix = "（摘录已截断）" + (" " + " ".join(citations) if citations else "")
    if len(suffix) >= limit:
        return ""
    prose = PDF_LINK.sub("", text)
    prefix = prose[:limit - len(suffix)].rstrip()
    prefix = re.sub(r"\[\[[^\]]*$", "", prefix)
    return prefix + suffix


def _snippets(document: _Document, tokens: set[str], budget: int) -> list[dict[str, str]]:
    chunks = _chunks(document)
    ranked = sorted(enumerate(chunks), key=lambda pair: (-len(tokens & _tokens(pair[1]["heading"] + " " + pair[1]["text"])), pair[0]))
    snippets = []
    remaining = max(0, budget)
    for _, chunk in ranked:
        excerpt = _excerpt(chunk["text"], min(2400, remaining))
        if not excerpt:
            continue
        snippets.append({"heading": chunk["heading"], "text": excerpt})
        remaining -= len(excerpt)
        if len(snippets) == 2 or remaining < 100:
            break
    return snippets


def knowledge_context(vault: Path, question: str, note_path: Optional[str] = None, limit: int = 4,
                      for_integration: bool = False, total_chars: int = 16000) -> dict[str, Any]:
    """Retrieve bounded excerpts; total_chars bounds snippet text characters."""
    vault = Path(vault).resolve()
    documents, warnings = _documents(vault)
    registry = _concept_registry(vault, documents)
    warnings.extend(registry["warnings"])
    _apply_concepts(documents, registry)
    representatives, _ = _graph(vault, documents, registry)
    by_path = {document.path: document for document in documents}
    anchor = None
    if note_path:
        path = Path(note_path)
        if path.is_absolute():
            try:
                note_path = path.resolve().relative_to(vault).as_posix()
            except ValueError:
                note_path = ""
        anchor = by_path.get(note_path)
        if anchor is None:
            warnings.append("指定的关联笔记不在可检索 wiki 页面中。")
        elif for_integration and anchor.kind in {"paper", "experiment"} and not anchor.reviewed:
            warnings.append("关联来源的人工审核无效或已过期；不能据此执行知识整合。")
    query_tokens, expansion_reasons, query_warnings = _query_concepts(question, registry)
    warnings.extend(query_warnings)
    requested = max(0, int(limit))
    eligible = {
        document.path: document for document in documents
        if representatives[document.path] == document.path
        and (not for_integration or document.kind == "canonical"
             or (document.kind in {"paper", "experiment"} and document.reviewed))
    }
    neighbors = _neighbor_index(list(eligible.values()))
    anchor_path = representatives[anchor.path] if anchor else None
    anchor_for_ranking = eligible.get(anchor_path) if anchor_path else None
    excluded = {anchor_path} if anchor_path else set()
    direct = []
    ranked_by_path = {}
    phrase = _query_phrase(question)
    for document in eligible.values():
        direct_score, reasons = _query_score(document, query_tokens, phrase)
        if direct_score <= 0:
            continue
        reasons.extend(expansion["reason"] for expansion in expansion_reasons
                       if document.path == expansion["target"] or expansion["target"] in document.entities
                       or expansion["tokens"] & (document.title_tokens | document.entity_tokens | document.body_tokens))
        # A query-matching anchor can seed expansion, but cannot be returned or
        # create query hits from its relationship score alone.
        direct.append((direct_score, document, list(reasons)))
        if document.path in excluded:
            continue
        if anchor_for_ranking:
            related_score, related_reasons = _relationships(anchor_for_ranking, document, neighbors)
            direct_score += related_score
            reasons.extend(related_reasons)
        ranked_by_path[document.path] = (direct_score, document, reasons)
    supplements = []
    for graph_score, document, graph_reasons in _graph_expansion(direct, eligible, neighbors, requested, excluded):
        current = ranked_by_path.get(document.path)
        score, reasons = (current[0], list(current[2])) if current else (0.0, [])
        if current is None and anchor_for_ranking:
            related_score, related_reasons = _relationships(anchor_for_ranking, document, neighbors)
            score += related_score
            reasons.extend(related_reasons)
        supplements.append((score + graph_score, document, reasons + graph_reasons))
    supplement_paths = {document.path for _, document, _ in supplements}
    ranked = sorted((item for path, item in ranked_by_path.items() if path not in supplement_paths),
                    key=lambda item: (-item[0], item[1].path))
    selected = ranked[:max(0, requested - len(supplements))] + supplements
    selected.sort(key=lambda item: (-item[0], item[1].path))
    results = []
    remaining = max(0, int(total_chars))
    for index, (score, document, reasons) in enumerate(selected):
        snippets = _snippets(document, query_tokens or (anchor.entity_tokens if anchor else set()), remaining // (len(selected) - index))
        remaining -= sum(len(snippet["text"]) for snippet in snippets)
        results.append({
            "note_path": document.path, "title": document.title, "status": document.status,
            "reviewed": document.reviewed, "paper_identity": document.paper_identity,
            "source_pdf": document.source_pdf, "score": round(score, 3), "reasons": reasons,
            "snippets": snippets, "validation_warnings": document.validation_warnings,
        })
    if any(by_path[result["note_path"]].kind in {"paper", "experiment"} and not result["reviewed"] for result in results):
        warnings.append("结果包含未经有效人工审核的来源，请按标注状态使用。")
    return {"query": question, "anchor_note": anchor.path if anchor else None, "results": results,
            "warnings": warnings}


def knowledge_map(vault: Path) -> dict[str, Any]:
    vault = Path(vault).resolve()
    documents, warnings = _documents(vault)
    registry = _concept_registry(vault, documents)
    warnings.extend(registry["warnings"])
    _apply_concepts(documents, registry)
    representatives, clues = _graph(vault, documents, registry)
    clues["missing_alias_targets"] = registry["missing_targets"]
    clues["ambiguous_aliases"] = registry["ambiguous_aliases"]
    unique = [document for document in documents if representatives[document.path] == document.path]
    neighbors = _neighbor_index(unique)
    nodes = [{"id": document.path, "note_path": document.path, "title": document.title,
              "type": document.kind, "status": document.status, "reviewed": document.reviewed,
              "paper_identity": document.paper_identity} for document in unique]
    edges = []
    for index, left in enumerate(unique):
        for right in unique[index + 1:]:
            _, reasons = _relationships(left, right, neighbors)
            if reasons:
                edges.append({"source": left.path, "target": right.path, "reasons": reasons})
    missing: dict[str, dict[str, str]] = defaultdict(dict)
    for document in unique:
        if document.kind not in {"paper", "experiment"} or not document.reviewed:
            continue
        identity = document.paper_identity or _string(document.fields.get("source_id")) or document.path
        if document.kind == "experiment" and identity.startswith("experiment:"):
            identity = identity.rsplit(":", 1)[0]
        for entity in document.missing_entities:
            missing[entity][identity] = document.path
    clues["recurring_missing_entities"] = [
        {"entity": entity, "source_identities": sorted(sources), "source_notes": sorted(sources.values())}
        for entity, sources in sorted(missing.items()) if len(sources) >= 2
    ]
    markers: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for document in documents:
        for match in CLAIM_MARKER.finditer(document.text):
            markers[match.group(1)].append({"note_path": document.path, "line": document.text.count("\n", 0, match.start()) + 1})
    clues["duplicate_claim_markers"] = [
        {"claim_id": claim_id, "locations": locations}
        for claim_id, locations in sorted(markers.items()) if len(locations) > 1
    ]
    warnings.append("关联和结构缺口只描述本地知识覆盖，不表示证据互相支持或科研新颖性；重复声明标记也可能来自交叉索引。")
    return {"nodes": nodes, "edges": edges, "health_clues": clues, "warnings": warnings}


def concept_maintenance(vault: Path) -> dict[str, Any]:
    """Describe explicit mappings and name-form candidates; never merge pages."""
    vault = Path(vault).resolve()
    documents, warnings = _documents(vault)
    registry = _concept_registry(vault, documents)
    warnings.extend(registry["warnings"])
    forms: dict[str, dict[str, set[str]]] = defaultdict(lambda: {
        "variants": set(), "canonical_targets": set(), "mentioned_in": set(), "unmapped_variants": set(),
    })
    for target, names in registry["family"].items():
        for name in names:
            if name.startswith("wiki/"):
                continue
            forms[_form_key(name)]["variants"].add(name)
            forms[_form_key(name)]["canonical_targets"].add(target)
    for document in documents:
        for raw in document.entities:
            entity = _wiki_target(raw.strip("[]"))
            if entity.startswith("wiki/"):
                entity = Path(entity).stem
            group = forms[_form_key(entity)]
            group["variants"].add(entity)
            group["mentioned_in"].add(document.path)
            if not registry["lookup"].get(_alias_key(entity)):
                group["unmapped_variants"].add(entity)
    candidates = []
    for _, group in sorted(forms.items()):
        if (len(group["variants"]) > 1 and group["canonical_targets"]
                and (len(group["canonical_targets"]) > 1 or group["unmapped_variants"])):
            candidates.append({"reason": "名称仅在大小写、空白或连字符形式上相近，尚未认定同义",
                               "variants": sorted(group["variants"]), "canonical_targets": sorted(group["canonical_targets"]),
                               "mentioned_in": sorted(group["mentioned_in"])})
    for ambiguity in registry["ambiguous_aliases"]:
        candidates.append({"reason": "已有名称或 aliases 同时关联多个 canonical 页面，需核对定义与适用条件",
                           "variants": ambiguity["spellings"], "canonical_targets": ambiguity["canonical_targets"],
                           "mentioned_in": []})
    return {"mapping_file": CONCEPT_ALIASES, "mapping_file_exists": (vault / CONCEPT_ALIASES).is_file(),
            "mappings": registry["mappings"], "ambiguous_aliases": registry["ambiguous_aliases"],
            "synonym_candidates": candidates, "missing_targets": registry["missing_targets"],
            "warnings": warnings,
            "scientific_condition_reminder": "名称相近或别名相同不证明科学等价；核对材料、温度、时间尺度、测量定义与适用条件，保留支持、限定和矛盾证据。"}


def concept_maintenance_markdown(payload: dict[str, Any]) -> str:
    """A Chinese review report only; the caller chooses where to save it."""
    def text(value: Any) -> str:
        return str(value).replace("\n", " ").replace("|", "\\|")
    def target(value: str) -> str:
        return "[[" + text(value.removesuffix(".md")) + "]]"
    lines = ["# 同义概念整理报告", "", "本报告只提供登记与待核对线索，不创建、合并、重命名或删除页面。",
             "", payload.get("scientific_condition_reminder", "请保留科学条件与来源差异。"), "",
             "## 已登记映射", "", "| 规范知识页 | 已登记别名 | 登记位置 | 状态 |", "| --- | --- | --- | --- |"]
    for row in payload.get("mappings", []):
        lines.append("| " + target(row["canonical"]) + " | " + ("、".join(text(alias) for alias in row["aliases"]) or "未登记额外别名")
                     + " | " + "、".join("页面别名属性" if origin == "frontmatter" else "集中登记表" for origin in row["origins"]) + " | "
                     + ("可用于解析/检索" if row["available"] else "待创建或核对，未用于解析") + " |")
    if not payload.get("mappings"):
        lines.append("| 暂无 | — | — | 可按需登记 |")
    lines.extend(["", "## 歧义别名", ""])
    for row in payload.get("ambiguous_aliases", []):
        lines.append("- “" + text(row["alias"]) + "” → " + "、".join(target(path) for path in row["canonical_targets"]) + "；未自动选择目标。")
    if not payload.get("ambiguous_aliases"):
        lines.append("未发现登记别名的目标歧义。")
    lines.extend(["", "## 待核对同义候选", ""])
    for row in payload.get("synonym_candidates", []):
        lines.append("- " + "、".join(text(variant) for variant in row["variants"]) + "：" + text(row["reason"]) + "。候选页面："
                     + "、".join(target(path) for path in row["canonical_targets"]))
        if row["mentioned_in"]:
            lines.append("  出现位置：" + "、".join(target(path) for path in row["mentioned_in"]))
    if not payload.get("synonym_candidates"):
        lines.append("未发现名称形式或既有 aliases 产生的待核对候选；这不表示不存在其他同义表达。")
    lines.extend(["", "## 目标缺失或未可用", ""])
    for row in payload.get("missing_targets", []):
        lines.append("- " + target(row["canonical"]) + "：" + text(row["reason"]) + "；未当作已解析实体。")
    if not payload.get("missing_targets"):
        lines.append("登记目标均可检索。")
    lines.extend(["", "## 数据问题", ""])
    lines.extend("- " + text(warning) for warning in payload.get("warnings", []))
    if not payload.get("warnings"):
        lines.append("未发现映射文件的数据问题。")
    lines.extend(["", "## 核对后如何生效", "",
                  "核对定义与科学条件后，打开目标知识页，在 Obsidian 的别名（aliases）属性中登记其他称呼。",
                  "也可使用集中登记表：[[" + text(payload.get("mapping_file", CONCEPT_ALIASES)) + "]]；保留无法确定的歧义。",
                  "登记目标实际存在且别名无歧义后，下次知识检索和整合上下文会读取并使用；仅拼写相近的候选不会自动生效。", ""])
    return "\n".join(lines)


def research_context(vault: Path) -> str:
    """Optional local research purpose, returned as data, at most 6000 chars."""
    path = Path(vault) / "system" / "knowledge" / "purpose.md"
    try:
        return path.read_text(encoding="utf-8")[:6000]
    except (OSError, UnicodeError):
        return ""

"""Stage 1.5: clean extracted pages before chunking. NON-DESTRUCTIVE — raw
per-page markdown in work/<hash>/pages/ (written by extract.py) is never
modified; this writes to work/<hash>/cleaned/pages/ and records everything
it excluded so a human can review/restore it later via the review UI's
Cleaning tab.

Two independent things happen here, both driven by pure, unit-tested
functions (`detect_furniture`, `is_structural_page`, `clean_pages`):

1. Furniture stripping — a line repeated across many pages (headers,
   footers, "Page X of Y", the running document title) is detected purely
   by cross-page frequency and removed from the cleaned copy only. Never
   applied inside a markdown table, to a line >80 chars, or to a line that
   looks like a safety warning (see _SAFETY_KEYWORD_RE) — verbatim
   repetition is what makes furniture detectable, but it's also exactly
   what a real safety notice printed on every page looks like, so it gets
   an explicit pass regardless of the restore-toggle safety net.

2. Structural page tagging — TOC/index/revision-history pages are flagged,
   not removed. Their chunks still get created downstream in chunk.py, just
   tagged metadata.section_type='structural' so they can be (and, per
   STATUS.md §9, MUST be) excluded from similarity search later.

`clean_document` is the thin I/O wrapper: reads work/<hash>/pages/*.md,
applies `clean_pages`, writes work/<hash>/cleaned/pages/*.md and
work/<hash>/furniture.json, and enforces the safety rail (>15% of lines
stripped stops the pipeline at status='review' instead of proceeding to
chunk/embed automatically — see STATUS.md §4).
"""

import json
import math
import re

from corpus.chunk import is_table_block

FURNITURE_MIN_PAGE_RATIO = 0.30
FURNITURE_MIN_PAGES = 5
FURNITURE_MAX_LINE_CHARS = 80
SAFETY_RAIL_STRIPPED_PCT = 15.0
STRUCTURAL_TOC_LINE_RATIO = 0.5

# Never treated as furniture, no matter how often a line repeats verbatim —
# a safety notice printed on every page (e.g. "Warning: disconnect power
# before servicing") is exactly the kind of content the furniture heuristic
# would otherwise flag, and this is a fire/security panel manual corpus:
# better to never auto-strip it than rely on a human noticing it's missing
# from furniture.json's restore list.
_SAFETY_KEYWORD_RE = re.compile(r"\b(warning|caution|danger|note:)\b", re.IGNORECASE)

_DIGIT_RUN_RE = re.compile(r"\d+")
_WHITESPACE_RE = re.compile(r"\s+")

_STRUCTURAL_HEADING_RE = re.compile(
    r"^(contents|index|revision|document history)", re.IGNORECASE
)
_TOC_LINE_RE = re.compile(r"(\.{2,}|\s{2,})\s*\d{1,4}\s*$")

_CLEANED_MARKER_RE = re.compile(
    r"^<!-- path: (text|vision) -->\n<!-- structural: (true|false) -->\n"
)


def _normalize_line(line: str) -> str:
    collapsed = _WHITESPACE_RE.sub(" ", line.strip())
    return _DIGIT_RUN_RE.sub("#", collapsed)


def _is_protected_from_furniture(line: str) -> bool:
    """Lines that can never be furniture regardless of repetition count."""
    if len(line) > FURNITURE_MAX_LINE_CHARS:
        return True
    return bool(_SAFETY_KEYWORD_RE.search(line))


def _page_blocks(text: str) -> list[tuple[list[str], bool]]:
    """Split page text into (lines, in_table) blocks using the same
    paragraph splitting chunk.py uses for chunking, so "is this line part
    of a table" lines up between the two stages."""
    blocks = []
    for para in re.split(r"\n\s*\n", text.strip()):
        para = para.strip()
        if not para:
            continue
        lines = [line for line in para.splitlines() if line.strip()]
        if not lines:
            continue
        blocks.append((lines, is_table_block(lines)))
    return blocks


def is_structural_page(text: str) -> bool:
    """TOC / index / revision-history pages: a heading matching
    contents/index/revision/document history, or a majority of lines that
    read like TOC entries (dot leaders or wide gaps before a trailing page
    number)."""
    blocks = _page_blocks(text)
    all_lines = [line for lines, _ in blocks for line in lines]
    if not all_lines:
        return False

    for lines, _ in blocks:
        if len(lines) == 1 and _STRUCTURAL_HEADING_RE.match(lines[0].strip()):
            return True

    toc_like = sum(1 for line in all_lines if _TOC_LINE_RE.search(line))
    return (toc_like / len(all_lines)) >= STRUCTURAL_TOC_LINE_RATIO


def furniture_threshold(total_pages: int) -> int:
    if total_pages == 0:
        return FURNITURE_MIN_PAGES
    return max(FURNITURE_MIN_PAGES, math.ceil(total_pages * FURNITURE_MIN_PAGE_RATIO))


def detect_furniture(pages: list[dict]) -> dict[str, dict]:
    """pages: [{"page": int, "text": str}, ...]. Returns
    {normalized_line: {"pages": [int, ...], "examples": [str, ...]}} for
    every normalized line that appears (as an eligible candidate — not
    inside a table, not >80 chars, not a safety-keyword line) on enough
    distinct pages to count as furniture."""
    threshold = furniture_threshold(len(pages))
    candidates: dict[str, dict] = {}

    for page in pages:
        page_num = page["page"]
        seen_on_this_page: set[str] = set()
        for lines, in_table in _page_blocks(page["text"]):
            if in_table:
                continue
            for line in lines:
                stripped = line.strip()
                if _is_protected_from_furniture(stripped):
                    continue
                normalized = _normalize_line(stripped)
                if normalized in seen_on_this_page:
                    continue  # count distinct pages, not occurrences
                seen_on_this_page.add(normalized)
                entry = candidates.setdefault(normalized, {"pages": [], "examples": []})
                entry["pages"].append(page_num)
                if len(entry["examples"]) < 2:
                    entry["examples"].append(stripped)

    return {
        normalized: entry
        for normalized, entry in candidates.items()
        if len(entry["pages"]) >= threshold
    }


def clean_pages(pages: list[dict], overrides: set[str] | None = None) -> tuple[list[dict], dict]:
    """Pure, DB/filesystem-free. pages: [{"page": int, "text": str}, ...].
    overrides: normalized line strings a human has explicitly restored (via
    the review UI) that must never be stripped even if they'd otherwise
    cross the furniture threshold.

    Returns (cleaned_pages, report):
      cleaned_pages: [{"page": int, "text": str, "structural": bool}, ...]
      report: JSON-serializable furniture.json content, including the
        stripped-line-percentage the safety rail checks.
    """
    overrides = overrides or set()
    total_pages = len(pages)
    furniture = detect_furniture(pages)
    for normalized in overrides:
        furniture.pop(normalized, None)

    cleaned_pages: list[dict] = []
    total_lines = 0
    stripped_lines = 0

    for page in pages:
        structural = is_structural_page(page["text"])
        kept_blocks: list[str] = []
        for lines, in_table in _page_blocks(page["text"]):
            kept_lines: list[str] = []
            for line in lines:
                stripped = line.strip()
                total_lines += 1
                normalized = _normalize_line(stripped)
                is_candidate = not in_table and not _is_protected_from_furniture(stripped)
                if is_candidate and normalized in furniture:
                    stripped_lines += 1
                    continue
                kept_lines.append(line)
            if kept_lines:
                kept_blocks.append("\n".join(kept_lines))
        cleaned_pages.append(
            {"page": page["page"], "text": "\n\n".join(kept_blocks), "structural": structural}
        )

    stripped_pct = round((stripped_lines / total_lines * 100), 2) if total_lines else 0.0
    report = {
        "total_pages": total_pages,
        "total_lines": total_lines,
        "stripped_lines": stripped_lines,
        "stripped_pct": stripped_pct,
        "threshold_pages": furniture_threshold(total_pages),
        "furniture": [
            {
                "normalized": normalized,
                "page_count": len(entry["pages"]),
                "example_pages": entry["pages"][:2],
                "example_lines": entry["examples"],
            }
            for normalized, entry in sorted(
                furniture.items(), key=lambda kv: -len(kv[1]["pages"])
            )
        ],
    }
    return cleaned_pages, report


def write_cleaned_page(path, extraction_path: str, structural: bool, content: str) -> None:
    marker = f"<!-- path: {extraction_path} -->\n<!-- structural: {str(structural).lower()} -->\n"
    path.write_text(marker + content, encoding="utf-8")


def read_cleaned_page(path) -> tuple[str, bool, str]:
    """Returns (extraction_path, structural, content)."""
    raw = path.read_text(encoding="utf-8")
    match = _CLEANED_MARKER_RE.match(raw)
    if match:
        return match.group(1), match.group(2) == "true", raw[match.end() :]
    return "text", False, raw


def clean_document(document_id: str, force: bool = False) -> dict:
    """Reads work/<hash>/pages/*.md, writes work/<hash>/cleaned/pages/*.md
    + work/<hash>/furniture.json. Resumable: if cleaned pages already exist
    for every raw page and force=False, the cleaned content is reused as-is
    (force=True is for the "restore a furniture line" flow, which changes
    what gets stripped and must regenerate). The safety-rail decision is
    always re-evaluated even on a cached report, though — that's what lets
    a human's "proceed anyway" override (a plain metadata update, no
    re-cleaning) actually unstick a document on the next `corpus retry`.

    Returns the furniture/cleaning report plus 'safety_rail_triggered': the
    caller (`_process` in cli.py) must not call chunk_document when true —
    the document has already been moved to status='review' with a warning
    instead."""
    from corpus import db
    from corpus.extract import read_page
    from corpus.paths import WORK_DIR

    doc_row = db.get_document(document_id)
    if doc_row is None:
        raise ValueError(f"no document {document_id}")

    file_hash = doc_row["file_hash"]
    pages_dir = WORK_DIR / file_hash / "pages"
    cleaned_dir = WORK_DIR / file_hash / "cleaned" / "pages"
    furniture_path = WORK_DIR / file_hash / "furniture.json"
    overrides_path = WORK_DIR / file_hash / "furniture_overrides.json"

    page_paths = sorted(pages_dir.glob("*.md"))
    if not page_paths:
        raise FileNotFoundError(f"no extracted pages in {pages_dir} (run extract first)")

    already_cleaned = (
        not force
        and cleaned_dir.exists()
        and len(list(cleaned_dir.glob("*.md"))) == len(page_paths)
        and furniture_path.exists()
    )

    if already_cleaned:
        report = json.loads(furniture_path.read_text(encoding="utf-8"))
    else:
        raw_pages = []
        extraction_paths = {}
        for p in page_paths:
            ext_path, text = read_page(p)
            page_num = int(p.stem)
            raw_pages.append({"page": page_num, "text": text})
            extraction_paths[page_num] = ext_path

        overrides: set[str] = set()
        if overrides_path.exists():
            overrides = set(json.loads(overrides_path.read_text(encoding="utf-8")))

        cleaned_pages, report = clean_pages(raw_pages, overrides=overrides)

        cleaned_dir.mkdir(parents=True, exist_ok=True)
        for cp in cleaned_pages:
            out_path = cleaned_dir / f"{cp['page']:03d}.md"
            write_cleaned_page(
                out_path, extraction_paths[cp["page"]], cp["structural"], cp["text"]
            )

        furniture_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    existing_metadata = doc_row.get("metadata") or {}
    proceed_override = bool(existing_metadata.get("proceed_override"))
    stripped_pct = report.get("stripped_pct", 0.0)
    triggered = stripped_pct > SAFETY_RAIL_STRIPPED_PCT and not proceed_override

    if triggered:
        db.update_document(
            document_id,
            {
                "status": "review",
                "metadata": {
                    **existing_metadata,
                    "cleaning_warning": {
                        "stripped_pct": stripped_pct,
                        "message": (
                            f"{stripped_pct}% of lines were stripped as furniture — above "
                            f"the {SAFETY_RAIL_STRIPPED_PCT}% safety threshold. The heuristic "
                            "may have misfired; review the Cleaning tab before this document "
                            "is chunked and embedded."
                        ),
                    },
                },
            },
        )

    report = {**report, "safety_rail_triggered": triggered}
    return report

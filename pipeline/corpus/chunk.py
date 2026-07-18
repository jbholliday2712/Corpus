"""Stage 3: split page markdown into chunks of ~500-1000 tokens with ~100
token overlap. Tables and numbered procedures are treated as atomic blocks
that never get split across a chunk boundary.

`chunk_pages` is the pure, DB-free algorithm — the thing worth unit-testing.
`chunk_document` is the thin I/O wrapper that reads work/<hash>/cleaned/pages/*.md
(written by clean.py) and writes rows to `chunks`.
"""

import re
from dataclasses import dataclass

DEFAULT_MAX_TOKENS = 1000
DEFAULT_OVERLAP_TOKENS = 100
RUNT_TOKEN_THRESHOLD = 50  # STATUS.md cleaning-stage rule: chunks below this
# get merged into the previous same-section chunk, or tagged section_type='runt'
# and excluded from retrieval — never deleted.

_TABLE_LINE_RE = re.compile(r"\|")
_PROCEDURE_LINE_RE = re.compile(r"^\s*\d+[.)]\s+\S")
_HEADING_MAX_CHARS = 80

# A single bold "**Label:** value" line (e.g. "**Page Number:** 4",
# "**Battery Status:** OK") is a vision-transcribed data field, not a
# section heading — real headings don't read as a labeled key/value pair.
# Left unfiltered, these get picked up by _is_heading (short, single-line,
# no trailing punctuation) and become `section` for every chunk after them
# until the next real heading, which is confusing wherever section is
# surfaced (the Cleaning/Chunks tabs, and especially the /graph view, where
# unrelated chunks scattered across many real pages all end up labeled with
# the same misleading field text).
_FIELD_VALUE_LINE_RE = re.compile(r"^\*\*[^*\n]+:\*\*")


def estimate_tokens(text: str) -> int:
    """Rough chars/4 approximation. Good enough for chunk sizing; not tied
    to any specific tokenizer."""
    return max(1, len(text) // 4)


@dataclass
class Block:
    text: str
    page_start: int
    page_end: int
    kind: str  # 'heading' | 'table' | 'procedure' | 'text'
    extraction_path: str = "text"  # 'text' | 'vision' — the page(s) it came from
    structural: bool = False  # the page(s) it came from were TOC/index/revision-history


def is_table_block(lines: list[str]) -> bool:
    """Public: reused by clean.py to exempt table lines from furniture
    stripping (a repeated table header row must never be treated as a
    page-footer-style repeated line)."""
    if len(lines) < 2:
        return False
    hits = sum(1 for line in lines if _TABLE_LINE_RE.search(line))
    return hits / len(lines) >= 0.8


def _is_procedure(lines: list[str]) -> bool:
    hits = sum(1 for line in lines if _PROCEDURE_LINE_RE.match(line))
    return hits / len(lines) >= 0.6


def _is_heading(para: str, lines: list[str]) -> bool:
    if len(lines) != 1:
        return False
    if len(para) > _HEADING_MAX_CHARS:
        return False
    if para.endswith((".", ",", ";", ":")):
        return False
    if _FIELD_VALUE_LINE_RE.match(para):
        return False
    return True


def _split_page_into_blocks(
    page_num: int, text: str, extraction_path: str, structural: bool
) -> list[Block]:
    blocks = []
    for para in re.split(r"\n\s*\n", text.strip()):
        para = para.strip()
        if not para:
            continue
        lines = [line for line in para.splitlines() if line.strip()]
        if not lines:
            continue
        if is_table_block(lines):
            kind = "table"
        elif _is_procedure(lines):
            kind = "procedure"
        elif _is_heading(para, lines):
            kind = "heading"
        else:
            kind = "text"
        blocks.append(
            Block(
                text=para,
                page_start=page_num,
                page_end=page_num,
                kind=kind,
                extraction_path=extraction_path,
                structural=structural,
            )
        )
    return blocks


def _combine_path(a: str, b: str) -> str:
    return "text" if a == "text" and b == "text" else "vision"


def _merge_adjacent_atomic(blocks: list[Block]) -> list[Block]:
    """Merge consecutive table/procedure blocks so a table or numbered list
    that got split into separate paragraphs by blank lines stays one block."""
    merged: list[Block] = []
    for block in blocks:
        if merged and merged[-1].kind == block.kind and block.kind in ("table", "procedure"):
            prev = merged[-1]
            merged[-1] = Block(
                text=prev.text + "\n" + block.text,
                page_start=prev.page_start,
                page_end=block.page_end,
                kind=block.kind,
                extraction_path=_combine_path(prev.extraction_path, block.extraction_path),
                structural=prev.structural or block.structural,
            )
        else:
            merged.append(block)
    return merged


def _take_overlap(blocks: list[Block], overlap_tokens: int) -> list[Block]:
    tail: list[Block] = []
    total = 0
    for block in reversed(blocks):
        if total >= overlap_tokens:
            break
        tail.insert(0, block)
        total += estimate_tokens(block.text)
    return tail


def _finalize(blocks: list[Block], section: str | None) -> dict:
    content = "\n\n".join(b.text for b in blocks)
    extraction_path = "text" if all(b.extraction_path == "text" for b in blocks) else "vision"
    metadata: dict = {}
    if any(b.structural for b in blocks):
        metadata["section_type"] = "structural"
    return {
        "content": content,
        "page_start": min(b.page_start for b in blocks),
        "page_end": max(b.page_end for b in blocks),
        "section": section,
        "extraction_path": extraction_path,
        "token_count": estimate_tokens(content),
        "metadata": metadata,
    }


def _pack_blocks(
    blocks: list[Block], max_tokens: int, overlap_tokens: int
) -> list[dict]:
    result: list[dict] = []
    current: list[Block] = []
    current_tokens = 0
    last_heading: str | None = None
    chunk_section: str | None = None

    for block in blocks:
        if block.kind == "heading":
            last_heading = block.text

        block_tokens = estimate_tokens(block.text)

        if block.kind in ("table", "procedure") and block_tokens > max_tokens:
            if current:
                result.append(_finalize(current, chunk_section))
                current, current_tokens = [], 0
            result.append(_finalize([block], last_heading))
            chunk_section = last_heading
            continue

        if current and current_tokens + block_tokens > max_tokens:
            result.append(_finalize(current, chunk_section))
            current = _take_overlap(current, overlap_tokens)
            current_tokens = sum(estimate_tokens(b.text) for b in current)
            chunk_section = last_heading

        if not current:
            chunk_section = last_heading

        current.append(block)
        current_tokens += block_tokens

    if current:
        result.append(_finalize(current, chunk_section))

    return result


def apply_runt_handling(chunks: list[dict]) -> list[dict]:
    """Any chunk under RUNT_TOKEN_THRESHOLD tokens is merged into the
    previous chunk if they share the same `section`, otherwise tagged
    metadata.section_type='runt' — never deleted, per the cleaning stage's
    NON-DESTRUCTIVE rule. Chunks already tagged (e.g. 'structural' by
    _finalize) are left alone here, both as merge sources and as merge
    targets: they're already excluded from retrieval, and merging unrelated
    content into/out of an already-classified chunk would blur why it was
    classified that way. Re-numbers chunk_index at the end since merges
    change the count."""
    result: list[dict] = []
    for chunk in chunks:
        tagged = bool(chunk.get("metadata", {}).get("section_type"))
        is_runt = chunk["token_count"] < RUNT_TOKEN_THRESHOLD and not tagged

        prev = result[-1] if result else None
        # 'structural' chunks come from a categorically different source
        # (a TOC/index page) and must not absorb unrelated runt content —
        # but a chunk already tagged 'runt' by an earlier iteration of this
        # same loop IS a valid merge target, so consecutive tiny
        # same-section chunks cascade into one instead of each becoming its
        # own isolated runt.
        prev_mergeable = (
            prev is not None
            and prev.get("metadata", {}).get("section_type") != "structural"
            and prev["section"] == chunk["section"]
        )

        if is_runt and prev_mergeable:
            merged_content = prev["content"] + "\n\n" + chunk["content"]
            new_token_count = estimate_tokens(merged_content)
            prev["content"] = merged_content
            prev["token_count"] = new_token_count
            prev["page_end"] = max(prev["page_end"], chunk["page_end"])
            prev["extraction_path"] = _combine_path(
                prev["extraction_path"], chunk["extraction_path"]
            )
            if new_token_count >= RUNT_TOKEN_THRESHOLD:
                # grew past the threshold via merging — no longer a runt
                prev["metadata"] = {
                    k: v for k, v in prev.get("metadata", {}).items() if k != "section_type"
                }
            continue

        if is_runt:
            chunk = {
                **chunk,
                "metadata": {**chunk.get("metadata", {}), "section_type": "runt"},
            }

        result.append(chunk)

    for i, c in enumerate(result):
        c["chunk_index"] = i
    return result


def chunk_pages(
    pages: list[dict],
    max_tokens: int = DEFAULT_MAX_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
) -> list[dict]:
    """pages: [{"page": int, "text": str, "extraction_path": "text"|"vision",
    "structural": bool}, ...] in reading order ("extraction_path" defaults
    to "text", "structural" to False, if omitted).
    Returns chunk dicts with chunk_index/content/page_start/page_end/section/
    extraction_path/token_count/metadata, ready to insert (minus
    document_id). A chunk's extraction_path is "vision" if any page it
    draws from was; metadata.section_type is "structural" if any page it
    draws from was flagged structural (TOC/index/revision-history) by
    clean.py. Runt handling (merge/tag chunks under 50 tokens) is a
    separate pass — see apply_runt_handling — not applied here, so this
    function stays a pure "pack blocks into chunks" step."""
    all_blocks: list[Block] = []
    for page in pages:
        all_blocks.extend(
            _split_page_into_blocks(
                page["page"],
                page["text"],
                page.get("extraction_path", "text"),
                page.get("structural", False),
            )
        )
    all_blocks = _merge_adjacent_atomic(all_blocks)

    chunks = _pack_blocks(all_blocks, max_tokens, overlap_tokens)
    for i, c in enumerate(chunks):
        c["chunk_index"] = i
    return chunks


def chunk_document(document_id: str) -> int:
    from corpus import db
    from corpus.clean import read_cleaned_page
    from corpus.paths import WORK_DIR

    doc_row = db.get_document(document_id)
    if doc_row is None:
        raise ValueError(f"no document {document_id}")

    # Resumable like extract/embed: if chunking already succeeded on a
    # previous run (e.g. this document is being retried after embed failed),
    # skip straight to done rather than re-inserting a duplicate chunk set —
    # that would also orphan any embeddings already written for the old rows.
    existing = db.count_chunks(document_id)
    if existing:
        db.update_document(document_id, {"status": "chunking"})
        return existing

    pages_dir = WORK_DIR / doc_row["file_hash"] / "cleaned" / "pages"
    page_paths = sorted(pages_dir.glob("*.md"))
    if not page_paths:
        raise FileNotFoundError(f"no cleaned pages in {pages_dir} (run clean first)")

    pages = []
    for p in page_paths:
        extraction_path, structural, text = read_cleaned_page(p)
        pages.append(
            {
                "page": int(p.stem),
                "text": text,
                "extraction_path": extraction_path,
                "structural": structural,
            }
        )

    chunks = chunk_pages(pages)
    chunks = apply_runt_handling(chunks)
    if chunks:
        rows = [{**c, "document_id": document_id} for c in chunks]
        db.insert_chunks(rows)

    db.update_document(document_id, {"status": "chunking"})
    return len(chunks)

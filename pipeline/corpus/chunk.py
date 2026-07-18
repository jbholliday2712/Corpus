"""Stage 3: split page markdown into chunks of ~500-1000 tokens with ~100
token overlap. Tables and numbered procedures are treated as atomic blocks
that never get split across a chunk boundary.

`chunk_pages` is the pure, DB-free algorithm — the thing worth unit-testing.
`chunk_document` is the thin I/O wrapper that reads work/<hash>/pages/*.md
and writes rows to `chunks`.
"""

import re
from dataclasses import dataclass

DEFAULT_MAX_TOKENS = 1000
DEFAULT_OVERLAP_TOKENS = 100

_TABLE_LINE_RE = re.compile(r"\|")
_PROCEDURE_LINE_RE = re.compile(r"^\s*\d+[.)]\s+\S")
_HEADING_MAX_CHARS = 80


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


def _is_table(lines: list[str]) -> bool:
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
    return True


def _split_page_into_blocks(page_num: int, text: str, extraction_path: str) -> list[Block]:
    blocks = []
    for para in re.split(r"\n\s*\n", text.strip()):
        para = para.strip()
        if not para:
            continue
        lines = [line for line in para.splitlines() if line.strip()]
        if not lines:
            continue
        if _is_table(lines):
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
    return {
        "content": content,
        "page_start": min(b.page_start for b in blocks),
        "page_end": max(b.page_end for b in blocks),
        "section": section,
        "extraction_path": extraction_path,
        "token_count": estimate_tokens(content),
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


def chunk_pages(
    pages: list[dict],
    max_tokens: int = DEFAULT_MAX_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
) -> list[dict]:
    """pages: [{"page": int, "text": str, "extraction_path": "text"|"vision"}, ...]
    in reading order ("extraction_path" defaults to "text" if omitted).
    Returns chunk dicts with chunk_index/content/page_start/page_end/section/
    extraction_path/token_count, ready to insert (minus document_id). A
    chunk's extraction_path is "vision" if any page it draws from was."""
    all_blocks: list[Block] = []
    for page in pages:
        all_blocks.extend(
            _split_page_into_blocks(
                page["page"], page["text"], page.get("extraction_path", "text")
            )
        )
    all_blocks = _merge_adjacent_atomic(all_blocks)

    chunks = _pack_blocks(all_blocks, max_tokens, overlap_tokens)
    for i, c in enumerate(chunks):
        c["chunk_index"] = i
    return chunks


def chunk_document(document_id: str) -> int:
    from corpus import db
    from corpus.extract import read_page
    from corpus.paths import WORK_DIR

    doc_row = db.get_document(document_id)
    if doc_row is None:
        raise ValueError(f"no document {document_id}")

    pages_dir = WORK_DIR / doc_row["file_hash"] / "pages"
    page_paths = sorted(pages_dir.glob("*.md"))
    if not page_paths:
        raise FileNotFoundError(f"no extracted pages in {pages_dir} (run extract first)")

    pages = []
    for p in page_paths:
        extraction_path, text = read_page(p)
        pages.append({"page": int(p.stem), "text": text, "extraction_path": extraction_path})

    chunks = chunk_pages(pages)
    if chunks:
        rows = [{**c, "document_id": document_id} for c in chunks]
        db.insert_chunks(rows)

    db.update_document(document_id, {"status": "chunking"})
    return len(chunks)

"""Stage 1: per-page triage + extraction. Every page tries PyMuPDF text
first; a page is routed to the NIM vision model when its text layer looks
too thin to be real content (scanned page) or too dense with short/grid-like
lines to be prose (probably a table PyMuPDF flattened badly). Worst case
every page goes through vision — slower, still works.
"""

import re

import pymupdf

from corpus import db
from corpus.paths import STORE_DIR, WORK_DIR
from corpus.providers import NIMClient

VISION_PROMPT = (
    "Transcribe this fire panel manual page to clean markdown. "
    "Preserve tables as markdown tables. Preserve numbered steps. "
    "Do not summarise or omit anything."
)

# ~150 DPI (PyMuPDF's default page space is 72 DPI).
_VISION_MATRIX = pymupdf.Matrix(150 / 72, 150 / 72)

_MIN_TEXT_CHARS = 50
_TABLE_DENSE_MIN_LINES = 12
_TABLE_DENSE_SHORT_LINE_RATIO = 0.65
_TABLE_DENSE_SHORT_LINE_CHARS = 20
_BLANK_NONWHITE_FRACTION = 0.002

_PAGE_MARKER_RE = re.compile(r"^<!-- path: (text|vision) -->\n")


def write_page(path, extraction_path: str, content: str) -> None:
    path.write_text(f"<!-- path: {extraction_path} -->\n{content}", encoding="utf-8")


def read_page(path) -> tuple[str, str]:
    """Returns (extraction_path, content). Files without the marker (e.g.
    written before M3) are treated as 'text'."""
    raw = path.read_text(encoding="utf-8")
    match = _PAGE_MARKER_RE.match(raw)
    if match:
        return match.group(1), raw[match.end():]
    return "text", raw


def _is_table_dense(text: str) -> bool:
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) < _TABLE_DENSE_MIN_LINES:
        return False
    short = sum(1 for line in lines if len(line.strip()) <= _TABLE_DENSE_SHORT_LINE_CHARS)
    return short / len(lines) >= _TABLE_DENSE_SHORT_LINE_RATIO


def _page_is_blank(page) -> bool:
    pix = page.get_pixmap(matrix=pymupdf.Matrix(0.3, 0.3), colorspace=pymupdf.csGRAY)
    samples = pix.samples
    if not samples:
        return True
    nonwhite = sum(1 for b in samples if b < 250)
    return (nonwhite / len(samples)) < _BLANK_NONWHITE_FRACTION


def needs_vision(page, text: str) -> bool:
    stripped = text.strip()
    if len(stripped) < _MIN_TEXT_CHARS and not _page_is_blank(page):
        return True
    return _is_table_dense(text)


def extract_document(document_id: str) -> int:
    """Write every page's markdown to work/<hash>/pages/NNN.md, tagged with
    which extraction path produced it. Resumable: a page already written on
    disk is left alone, so a crash mid-document just re-runs the pages that
    didn't make it. Returns the page count."""
    doc_row = db.get_document(document_id)
    if doc_row is None:
        raise ValueError(f"no document {document_id}")

    file_hash = doc_row["file_hash"]
    pdf_path = STORE_DIR / f"{file_hash}.pdf"
    if not pdf_path.exists():
        raise FileNotFoundError(f"{pdf_path} missing (was it ingested?)")

    db.update_document(document_id, {"status": "extracting"})

    pages_dir = WORK_DIR / file_hash / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)

    client = None  # constructed lazily: a pure-text document needs no NIM call here

    pdf = pymupdf.open(pdf_path)
    try:
        page_count = pdf.page_count
        for i in range(page_count):
            out_path = pages_dir / f"{i + 1:03d}.md"
            if out_path.exists():
                continue

            page = pdf[i]
            text = page.get_text()
            if needs_vision(page, text):
                if client is None:
                    client = NIMClient()
                png_bytes = page.get_pixmap(matrix=_VISION_MATRIX).tobytes("png")
                content = client.vision_transcribe(png_bytes, VISION_PROMPT)
                write_page(out_path, "vision", content)
            else:
                write_page(out_path, "text", text)
    finally:
        pdf.close()

    db.update_document(document_id, {"page_count": page_count})
    return page_count

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

NO_CONTENT_SENTINEL = "NO_CONTENT"

VISION_PROMPT = (
    "Transcribe this fire panel manual page to clean markdown. "
    "Preserve tables as markdown tables. Preserve numbered steps. "
    "Do not summarise or omit anything. If the page has no manual content "
    "to transcribe (for example: a blank page, a cover page, or a page "
    "showing only a logo, branding, or compliance marks with no "
    f"instructional text), respond with exactly the single word: "
    f"{NO_CONTENT_SENTINEL}. Never invent content that is not visibly on "
    "the page."
)

# ~150 DPI (PyMuPDF's default page space is 72 DPI).
_VISION_MATRIX = pymupdf.Matrix(150 / 72, 150 / 72)

_MIN_TEXT_CHARS = 50
_TABLE_DENSE_MIN_LINES = 12
_TABLE_DENSE_SHORT_LINE_RATIO = 0.65
_TABLE_DENSE_SHORT_LINE_CHARS = 20
_BLANK_NONWHITE_FRACTION = 0.002

_FLAT_GRAPHIC_MATRIX = pymupdf.Matrix(0.3, 0.3)  # same scale as the blank check
_FLAT_GRAPHIC_GRID = 10  # page divided into a 10x10 grid of cells
_FLAT_GRAPHIC_CELL_STD_THRESHOLD = 12  # a cell counts as "textured" above this
_FLAT_GRAPHIC_MIN_TEXTURED_ROW_FRACTION = 0.3  # below this, the page reads as
# a handful of flat color blocks (a cover/logo/branding page) rather than
# real content. Deliberately measured as *row coverage*, not overall cell
# fraction: a single shape's edge (e.g. a solid color rectangle's border)
# lights up a thin ring of high-variance cells that can be a big chunk of
# total cells without the page having any real content — real running text
# or diagrams instead vary across most of the page's vertical extent, so a
# row is only "textured" once and rows are counted, not individual cells.

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


def _is_flat_graphic(page) -> bool:
    """True when the rendered page is dominated by a few large uniform-color
    regions (e.g. a cover with solid color blocks and a small logo) rather
    than genuinely dense visual content (real scanned text or diagrams).
    Vision-language models will confidently fabricate plausible-sounding
    manual content for a page that has nothing real to transcribe — asking
    the model to say "nothing here" isn't reliable (see VISION_PROMPT's
    NO_CONTENT_SENTINEL, which this heuristic exists because that alone
    wasn't enough), so pages like this are kept off the vision path
    entirely rather than trusting the model to decline."""
    pix = page.get_pixmap(matrix=_FLAT_GRAPHIC_MATRIX, colorspace=pymupdf.csGRAY)
    samples = pix.samples
    width, height, stride = pix.width, pix.height, pix.stride
    if not samples or width < _FLAT_GRAPHIC_GRID or height < _FLAT_GRAPHIC_GRID:
        return False

    cell_w = width // _FLAT_GRAPHIC_GRID
    cell_h = height // _FLAT_GRAPHIC_GRID
    textured_rows = 0
    total_rows = 0
    for gy in range(_FLAT_GRAPHIC_GRID):
        y0, y1 = gy * cell_h, min((gy + 1) * cell_h, height)
        if y0 >= y1:
            continue
        total_rows += 1
        row_has_texture = False
        for gx in range(_FLAT_GRAPHIC_GRID):
            x0, x1 = gx * cell_w, min((gx + 1) * cell_w, width)
            values = [
                samples[y * stride + x]
                for y in range(y0, y1)
                for x in range(x0, x1)
            ]
            if not values:
                continue
            mean = sum(values) / len(values)
            variance = sum((v - mean) ** 2 for v in values) / len(values)
            if variance**0.5 > _FLAT_GRAPHIC_CELL_STD_THRESHOLD:
                row_has_texture = True
                break
        if row_has_texture:
            textured_rows += 1

    if total_rows == 0:
        return False
    return (textured_rows / total_rows) < _FLAT_GRAPHIC_MIN_TEXTURED_ROW_FRACTION


def _vision_content_or_empty(raw: str) -> str:
    """The model is asked to respond with NO_CONTENT_SENTINEL for a page
    with nothing to transcribe; turn that into empty page content so
    chunk.py's blank-paragraph handling naturally produces no chunk for it,
    instead of writing whatever the model said verbatim."""
    return "" if raw.strip() == NO_CONTENT_SENTINEL else raw


def needs_vision(page, text: str) -> bool:
    stripped = text.strip()
    if len(stripped) < _MIN_TEXT_CHARS:
        if _page_is_blank(page) or _is_flat_graphic(page):
            return False
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
                write_page(out_path, "vision", _vision_content_or_empty(content))
            else:
                write_page(out_path, "text", text)
    finally:
        pdf.close()

    db.update_document(document_id, {"page_count": page_count})
    return page_count

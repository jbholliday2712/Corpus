import random

import pymupdf

from corpus.extract import (
    NO_CONTENT_SENTINEL,
    _is_flat_graphic,
    _is_table_dense,
    _vision_content_or_empty,
    needs_vision,
    read_page,
    write_page,
)


def _new_page(text: str | None = None, draw_box: bool = False, draw_scribble: bool = False):
    doc = pymupdf.open()
    page = doc.new_page()
    if text:
        page.insert_text((72, 72), text)
    if draw_box:
        # Full-width flat color bands with no vertical edges — this is what
        # a real cover/branding page looks like (confirmed against an actual
        # manual's back cover: two edge-to-edge color blocks + a small
        # logo). A box with vertical edges *away* from the page margins is
        # deliberately not used here — that could plausibly be a real boxed
        # diagram or photo, so it's correct for that case to still reach
        # vision; edge-to-edge bands are the shape a flat design page has.
        w, h = page.rect.width, page.rect.height
        page.draw_rect(pymupdf.Rect(0, 0, w, h * 0.35), fill=(0.8, 0.1, 0.1))
        page.draw_rect(pymupdf.Rect(0, h * 0.85, w, h), fill=(0.8, 0.1, 0.1))
    if draw_scribble:
        # Many small, irregularly placed line segments — stands in for a
        # genuinely scanned page of text/diagrams, which has lots of local
        # pixel variation rather than a few large uniform blocks.
        rng = random.Random(42)
        for _ in range(500):
            x0 = rng.uniform(40, 550)
            y0 = rng.uniform(40, 780)
            x1 = x0 + rng.uniform(-12, 12)
            y1 = y0 + rng.uniform(-12, 12)
            page.draw_line(
                pymupdf.Point(x0, y0), pymupdf.Point(x1, y1), color=(0, 0, 0), width=0.8
            )
    return doc, page


def test_needs_vision_false_for_normal_text_page():
    doc, page = _new_page("A perfectly ordinary paragraph of manual text that reads fine.")
    try:
        text = page.get_text()
        assert not needs_vision(page, text)
    finally:
        doc.close()


def test_needs_vision_true_for_scanned_looking_page():
    # No extractable text, but the page has genuinely dense/textured visual
    # content (simulated scan), not just a flat color block.
    doc, page = _new_page(text=None, draw_scribble=True)
    try:
        text = page.get_text()
        assert text.strip() == ""
        assert needs_vision(page, text)
    finally:
        doc.close()


def test_needs_vision_false_for_truly_blank_page():
    doc, page = _new_page(text=None, draw_box=False)
    try:
        text = page.get_text()
        assert not needs_vision(page, text)
    finally:
        doc.close()


def test_needs_vision_false_for_flat_graphic_cover_page():
    # No extractable text, and the page isn't blank either — but it's just a
    # solid color block (e.g. a cover page), not real content. This must NOT
    # go to vision: a vision-language model asked to transcribe a page with
    # nothing real on it will confidently fabricate plausible-sounding
    # manual content rather than admit there's nothing there.
    doc, page = _new_page(text=None, draw_box=True)
    try:
        text = page.get_text()
        assert text.strip() == ""
        assert not needs_vision(page, text)
    finally:
        doc.close()


def test_is_flat_graphic_true_for_solid_block():
    doc, page = _new_page(text=None, draw_box=True)
    try:
        assert _is_flat_graphic(page)
    finally:
        doc.close()


def test_is_flat_graphic_false_for_textured_scribble():
    doc, page = _new_page(text=None, draw_scribble=True)
    try:
        assert not _is_flat_graphic(page)
    finally:
        doc.close()


def test_is_table_dense_detects_grid_like_text():
    table_text = "\n".join(f"Zone {i}   Addr {i:03d}" for i in range(20))
    assert _is_table_dense(table_text)


def test_is_table_dense_false_for_prose():
    prose = "\n".join(
        [
            "This is a normal paragraph describing how the panel should be",
            "configured during commissioning, written across several lines",
            "of ordinary sentence-length prose rather than short grid rows.",
        ]
    )
    assert not _is_table_dense(prose)


def test_write_read_page_roundtrip(tmp_path):
    path = tmp_path / "001.md"
    write_page(path, "vision", "# Heading\n\nBody text.")
    extraction_path, content = read_page(path)
    assert extraction_path == "vision"
    assert content == "# Heading\n\nBody text."


def test_read_page_defaults_to_text_without_marker(tmp_path):
    path = tmp_path / "002.md"
    path.write_text("Plain content, no marker line.", encoding="utf-8")
    extraction_path, content = read_page(path)
    assert extraction_path == "text"
    assert content == "Plain content, no marker line."


def test_no_content_sentinel_becomes_empty_string():
    assert _vision_content_or_empty(NO_CONTENT_SENTINEL) == ""
    assert _vision_content_or_empty(f"  {NO_CONTENT_SENTINEL}  ") == ""


def test_real_transcription_passes_through_unchanged():
    real = "**Wiring zones**\n\n| Zone | Terminal |\n| --- | --- |\n| 1 | Z1 |"
    assert _vision_content_or_empty(real) == real

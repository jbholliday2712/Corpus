import pymupdf

from corpus.extract import _is_table_dense, needs_vision, read_page, write_page


def _new_page(text: str | None = None, draw_box: bool = False):
    doc = pymupdf.open()
    page = doc.new_page()
    if text:
        page.insert_text((72, 72), text)
    if draw_box:
        page.draw_rect(pymupdf.Rect(50, 50, 500, 700), fill=(0, 0, 0))
    return doc, page


def test_needs_vision_false_for_normal_text_page():
    doc, page = _new_page("A perfectly ordinary paragraph of manual text that reads fine.")
    try:
        text = page.get_text()
        assert not needs_vision(page, text)
    finally:
        doc.close()


def test_needs_vision_true_for_scanned_looking_page():
    # No extractable text, but the page clearly has visual content (a filled box).
    doc, page = _new_page(text=None, draw_box=True)
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

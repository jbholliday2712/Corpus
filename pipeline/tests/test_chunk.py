from corpus.chunk import chunk_pages, estimate_tokens


def test_single_short_page_is_one_chunk():
    pages = [{"page": 1, "text": "Some short introductory text about a fire panel."}]
    chunks = chunk_pages(pages)
    assert len(chunks) == 1
    assert chunks[0]["chunk_index"] == 0
    assert chunks[0]["page_start"] == 1
    assert chunks[0]["page_end"] == 1
    assert chunks[0]["extraction_path"] == "text"
    assert "fire panel" in chunks[0]["content"]


def test_heading_is_recorded_as_section():
    pages = [
        {
            "page": 1,
            "text": "Zone Wiring\n\nConnect the zone cable to terminals 1 and 2.",
        }
    ]
    chunks = chunk_pages(pages)
    assert chunks[0]["section"] == "Zone Wiring"


def test_large_document_splits_into_multiple_chunks_with_increasing_pages():
    filler = "This paragraph describes panel configuration in some detail. " * 15
    pages = [{"page": i, "text": filler} for i in range(1, 9)]
    chunks = chunk_pages(pages, max_tokens=200, overlap_tokens=20)
    assert len(chunks) > 1
    for i, c in enumerate(chunks):
        assert c["chunk_index"] == i
    # page ranges should be non-decreasing across chunks
    starts = [c["page_start"] for c in chunks]
    assert starts == sorted(starts)


def test_table_is_never_split_across_chunks():
    table = "\n".join(
        ["| Zone | Device | Address |", "|---|---|---|"]
        + [f"| {i} | Detector | {i:03d} |" for i in range(30)]
    )
    pages = [
        {"page": 1, "text": "Zone Table\n\n" + table + "\n\nSome text after the table."}
    ]
    chunks = chunk_pages(pages, max_tokens=50, overlap_tokens=10)
    table_chunks = [c for c in chunks if "| Zone | Device | Address |" in c["content"]]
    assert len(table_chunks) == 1
    assert table_chunks[0]["content"].count("| Zone | Device | Address |") == 1
    # the full table survives intact even though it exceeds max_tokens
    for i in range(30):
        assert f"| {i} | Detector | {i:03d} |" in table_chunks[0]["content"]


def test_numbered_procedure_is_never_split_across_chunks():
    steps = "\n\n".join(f"{i}. Do step number {i} of the commissioning procedure." for i in range(1, 12))
    pages = [{"page": 1, "text": "Commissioning\n\n" + steps}]
    chunks = chunk_pages(pages, max_tokens=40, overlap_tokens=5)
    procedure_chunks = [c for c in chunks if "1. Do step number 1" in c["content"]]
    assert len(procedure_chunks) == 1
    for i in range(1, 12):
        assert f"{i}. Do step number {i}" in procedure_chunks[0]["content"]


def test_overlap_carries_trailing_content_into_next_chunk():
    paragraphs = [
        f"Paragraph number {i} describing some fire panel configuration "
        "detail that takes a bit of space to write out in full."
        for i in range(1, 21)
    ]
    pages = [{"page": 1, "text": "\n\n".join(paragraphs)}]
    chunks = chunk_pages(pages, max_tokens=150, overlap_tokens=50)
    assert len(chunks) >= 2
    tail_of_first = chunks[0]["content"][-40:]
    assert tail_of_first.strip() in chunks[1]["content"]


def test_estimate_tokens_is_positive_and_monotonic():
    assert estimate_tokens("x") >= 1
    assert estimate_tokens("a" * 400) > estimate_tokens("a" * 40)


def test_all_text_pages_produce_text_extraction_path():
    pages = [
        {"page": 1, "text": "Ordinary paragraph one.", "extraction_path": "text"},
        {"page": 2, "text": "Ordinary paragraph two.", "extraction_path": "text"},
    ]
    chunks = chunk_pages(pages)
    assert all(c["extraction_path"] == "text" for c in chunks)


def test_vision_page_flags_its_chunk_as_vision():
    pages = [
        {"page": 1, "text": "Digitally extracted paragraph.", "extraction_path": "text"},
        {"page": 2, "text": "Vision-transcribed paragraph.", "extraction_path": "vision"},
    ]
    chunks = chunk_pages(pages, max_tokens=5, overlap_tokens=0)
    by_page = {c["page_start"]: c for c in chunks}
    assert by_page[1]["extraction_path"] == "text"
    assert by_page[2]["extraction_path"] == "vision"


def test_extraction_path_defaults_to_text_when_omitted():
    pages = [{"page": 1, "text": "No extraction_path key supplied."}]
    chunks = chunk_pages(pages)
    assert chunks[0]["extraction_path"] == "text"

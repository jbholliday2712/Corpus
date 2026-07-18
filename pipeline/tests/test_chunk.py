from corpus.chunk import apply_runt_handling, chunk_pages, estimate_tokens


def _chunk(index, content, section, token_count, extraction_path="text", metadata=None, page=1):
    return {
        "content": content,
        "page_start": page,
        "page_end": page,
        "section": section,
        "extraction_path": extraction_path,
        "token_count": token_count,
        "metadata": metadata or {},
        "chunk_index": index,
    }


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


def test_bold_field_value_line_is_not_treated_as_a_heading():
    # A real vision-transcription artifact seen on a scanned manual: a bold
    # "**Label:** value" line (a data field, not a section title) was being
    # picked up by the generic single-line/short/no-trailing-punctuation
    # heading heuristic, becoming `section` for every chunk after it —
    # confusing wherever section is surfaced, especially unrelated chunks
    # across many real pages all showing the same misleading label in the
    # graph view.
    pages = [
        {
            "page": 1,
            "text": "**Page Number:** 4\n\nSome real body text about wiring the zone.",
        }
    ]
    chunks = chunk_pages(pages)
    assert chunks[0]["section"] is None
    assert "Page Number" in chunks[0]["content"]  # still real content, just not a heading


def test_bold_field_value_line_does_not_overwrite_a_real_heading():
    pages = [
        {
            "page": 1,
            "text": (
                "Zone Wiring\n\n"
                "**Page Number:** 4\n\n"
                "Connect the zone cable to terminals 1 and 2."
            ),
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


def test_empty_page_contributes_no_chunks():
    """A page extract.py flagged as NO_CONTENT (blank/cover/logo-only) is
    written with empty content; it must not turn into a fabricated chunk."""
    pages = [
        {"page": 1, "text": "Real content on this page.", "extraction_path": "text"},
        {"page": 2, "text": "", "extraction_path": "vision"},
    ]
    chunks = chunk_pages(pages)
    assert len(chunks) == 1
    assert chunks[0]["page_end"] == 1


def test_runt_merges_into_previous_chunk_with_same_section():
    chunks = [
        _chunk(0, "Zone Wiring", "Zone Wiring", token_count=3),
        _chunk(1, "Connect the cable.", "Zone Wiring", token_count=5),
    ]
    result = apply_runt_handling(chunks)
    assert len(result) == 1
    assert result[0]["content"] == "Zone Wiring\n\nConnect the cable."
    assert result[0]["chunk_index"] == 0


def test_runt_cascades_across_multiple_consecutive_small_chunks():
    chunks = [
        _chunk(0, "a", "S", token_count=3),
        _chunk(1, "b", "S", token_count=3),
        _chunk(2, "c", "S", token_count=3),
    ]
    result = apply_runt_handling(chunks)
    assert len(result) == 1
    assert result[0]["content"] == "a\n\nb\n\nc"


def test_runt_with_different_section_is_tagged_not_merged():
    chunks = [
        _chunk(0, "Zone Wiring intro text here.", "Zone Wiring", token_count=100),
        _chunk(1, "Different Section", "Commissioning", token_count=4),
    ]
    result = apply_runt_handling(chunks)
    assert len(result) == 2
    assert result[1]["metadata"] == {"section_type": "runt"}
    assert result[1]["content"] == "Different Section"


def test_first_chunk_runt_with_no_previous_is_tagged():
    chunks = [_chunk(0, "Tiny opener.", None, token_count=4)]
    result = apply_runt_handling(chunks)
    assert len(result) == 1
    assert result[0]["metadata"] == {"section_type": "runt"}


def test_runt_merge_clears_tag_once_combined_size_passes_threshold():
    chunks = [
        _chunk(0, "x" * 40, "S", token_count=10),
        _chunk(1, "y" * 400, "S", token_count=10),  # declared small; real content is long
    ]
    result = apply_runt_handling(chunks)
    assert len(result) == 1
    assert result[0]["metadata"] == {}
    assert result[0]["token_count"] >= 50


def test_structural_chunk_is_never_a_runt_merge_target():
    chunks = [
        _chunk(0, "TOC entry", "Contents", token_count=5, metadata={"section_type": "structural"}),
        _chunk(1, "tiny runt", "Contents", token_count=4),
    ]
    result = apply_runt_handling(chunks)
    assert len(result) == 2
    assert result[0]["metadata"] == {"section_type": "structural"}
    assert result[1]["metadata"] == {"section_type": "runt"}


def test_already_structural_chunk_is_not_reclassified_as_runt():
    chunks = [_chunk(0, "TOC", "Contents", token_count=3, metadata={"section_type": "structural"})]
    result = apply_runt_handling(chunks)
    assert result[0]["metadata"] == {"section_type": "structural"}


def test_normal_sized_chunks_pass_through_unchanged():
    chunks = [
        _chunk(0, "a" * 400, "S1", token_count=100),
        _chunk(1, "b" * 400, "S2", token_count=100),
    ]
    result = apply_runt_handling(chunks)
    assert len(result) == 2
    assert [c["chunk_index"] for c in result] == [0, 1]


def test_structural_metadata_set_when_any_source_page_is_structural():
    pages = [
        {"page": 1, "text": "Contents\n\nInstallation .......... 4", "structural": True},
    ]
    chunks = chunk_pages(pages)
    assert chunks[0]["metadata"] == {"section_type": "structural"}


def test_no_structural_metadata_for_ordinary_pages():
    pages = [{"page": 1, "text": "Ordinary prose about zone wiring.", "structural": False}]
    chunks = chunk_pages(pages)
    assert chunks[0]["metadata"] == {}

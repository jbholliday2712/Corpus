from corpus.clean import (
    _normalize_line,
    clean_pages,
    detect_furniture,
    furniture_threshold,
    is_structural_page,
)

# Deliberately varied, non-templated sentences — using "page N" style text
# for the body would itself normalize into a repeated pattern across pages
# and register as furniture, contaminating tests that want a "normal prose,
# not furniture" control.
_BODY_SENTENCES = [
    "Connect the zone cable to terminal block TB1.",
    "Confirm the panel powers up and the LED sequence completes.",
    "Set the DIP switches according to the configuration table.",
    "Route the cable through the designated conduit entry.",
    "Verify earth continuity before applying mains power.",
    "Programme the zone type using the keypad menu.",
    "Test the sounder circuit for correct polarity.",
    "Record the commissioning date in the log book.",
    "Check battery voltage is within the specified range.",
    "Label each zone according to the wiring schedule.",
    "Inspect all connections for correct torque.",
    "Isolate the mains supply before opening the enclosure.",
]


def _pages_with_repeated_line(n: int, repeated: str) -> list[dict]:
    if n > len(_BODY_SENTENCES):
        raise ValueError("extend _BODY_SENTENCES for a larger fixture")
    return [
        {"page": i, "text": f"{_BODY_SENTENCES[i - 1]}\n\n{repeated}"} for i in range(1, n + 1)
    ]


def test_repeated_footer_is_detected_as_furniture():
    pages = _pages_with_repeated_line(10, "CTec XFP Engineering Manual — Page 3 of 10")
    # digit runs normalize to '#', so every page's footer collapses to the
    # same normalized string despite the page number changing.
    furniture = detect_furniture(pages)
    assert len(furniture) == 1
    entry = next(iter(furniture.values()))
    assert entry["pages"] == list(range(1, 11))
    assert len(entry["examples"]) == 2


def test_repeated_footer_is_stripped_from_cleaned_output():
    pages = _pages_with_repeated_line(10, "CTec XFP Engineering Manual — Page 3 of 10")
    cleaned, report = clean_pages(pages)
    assert report["stripped_lines"] == 10
    assert report["stripped_pct"] > 0
    for cp in cleaned:
        assert "Engineering Manual" not in cp["text"]
    for i, sentence in enumerate(_BODY_SENTENCES[:10], start=1):
        assert sentence in cleaned[i - 1]["text"]


def test_repeated_table_row_is_never_stripped():
    # A markdown table header repeated at the top of a multi-page zone
    # table — this must survive even though it's identical on every page,
    # because it's real content, not a page furniture artifact.
    table_header = "| Zone | Device | Address |\n|---|---|---|"
    pages = [
        {
            "page": i,
            "text": f"{_BODY_SENTENCES[i - 1]}\n\n{table_header}\n| {i} | Detector | {i:03d} |",
        }
        for i in range(1, 10)
    ]
    furniture = detect_furniture(pages)
    assert not any("zone" in k.lower() and "device" in k.lower() for k in furniture)
    assert not any("|---|---|---|" in k for k in furniture)

    cleaned, report = clean_pages(pages)
    for cp in cleaned:
        assert "| Zone | Device | Address |" in cp["text"]
    assert report["stripped_lines"] == 0


def test_repeated_safety_warning_is_never_stripped():
    warning = "Warning: disconnect power before servicing this panel."
    pages = _pages_with_repeated_line(12, warning)
    furniture = detect_furniture(pages)
    assert not any("disconnect power" in k.lower() for k in furniture)

    cleaned, report = clean_pages(pages)
    for cp in cleaned:
        assert "disconnect power" in cp["text"]
    assert report["stripped_lines"] == 0


def test_line_appearing_on_few_pages_is_not_furniture():
    # Appears on 3 of 20 pages (15%) — below both the 30% ratio and the
    # min-5-pages floor, so it's coincidental repetition, not furniture.
    pages = [{"page": i, "text": f"Distinct content unique to page {i} only."} for i in range(1, 21)]
    pages[0]["text"] += "\n\nRepeated aside."
    pages[5]["text"] += "\n\nRepeated aside."
    pages[10]["text"] += "\n\nRepeated aside."
    furniture = detect_furniture(pages)
    assert not any("repeated aside" in k.lower() for k in furniture)


def test_long_line_is_never_flagged_even_if_repeated():
    long_line = "This is a deliberately long repeated disclaimer sentence that exceeds eighty characters in total length by design."
    assert len(long_line) > 80
    pages = _pages_with_repeated_line(10, long_line)
    furniture = detect_furniture(pages)
    assert len(furniture) == 0


def test_small_document_below_min_pages_never_flags_furniture():
    # Only 3 pages total — even 100% repetition can't reach the min-5-page
    # floor, so nothing should ever be flagged for a document this short.
    pages = _pages_with_repeated_line(3, "Some Manual — Rev 1")
    furniture = detect_furniture(pages)
    assert len(furniture) == 0


def test_furniture_threshold_uses_the_larger_of_ratio_and_minimum():
    assert furniture_threshold(10) == 5  # 30% of 10 = 3, floored up to min 5
    assert furniture_threshold(100) == 30  # 30% of 100 = 30, exceeds the min


def test_is_structural_page_true_for_contents_heading():
    text = "Contents\n\nInstallation ................ 4\nCommissioning ............... 9\nWiring ....................... 14"
    assert is_structural_page(text)


def test_is_structural_page_true_for_dot_leader_majority():
    text = "\n".join(f"Section {i} .......... {i * 2}" for i in range(1, 8))
    assert is_structural_page(text)


def test_is_structural_page_false_for_normal_prose():
    text = "Zone Wiring\n\nConnect the zone cable to terminals 1 and 2, then confirm the LED illuminates."
    assert not is_structural_page(text)


def test_structural_flag_propagates_to_cleaned_pages():
    toc_page = {"page": 1, "text": "Contents\n\nInstallation .......... 4\nWiring .......... 9"}
    prose_page = {"page": 2, "text": "Installation\n\nMount the panel to the wall using four screws."}
    cleaned, _ = clean_pages([toc_page, prose_page])
    by_page = {cp["page"]: cp for cp in cleaned}
    assert by_page[1]["structural"] is True
    assert by_page[2]["structural"] is False


def test_restore_override_exempts_a_line_even_over_threshold():
    footer = "Ace Fire & Security — Confidential"
    pages = _pages_with_repeated_line(10, footer)
    normalized = _normalize_line(footer)
    cleaned, report = clean_pages(pages, overrides={normalized})
    assert report["stripped_lines"] == 0
    for cp in cleaned:
        assert footer in cp["text"]


_SECOND_PARAGRAPH_SENTENCES = [
    "Torque all terminal screws to the manufacturer's specification.",
    "Apply silicone sealant around the external cable gland.",
    "Fit the anti-tamper spring clip to the enclosure door.",
    "Confirm the fault relay operates on loss of mains supply.",
    "Log the final quiescent current reading on the test sheet.",
    "Cross-check the zone list against the architect's drawings.",
    "Leave a spare fuse of the correct rating inside the enclosure.",
]


def test_paragraph_structure_is_preserved_after_stripping():
    # Non-furniture content on either side of a stripped footer must stay
    # separated by a blank line for chunk.py's paragraph splitting to work.
    pages = [
        {
            "page": i,
            "text": f"{_BODY_SENTENCES[i - 1]}\n\n{_SECOND_PARAGRAPH_SENTENCES[i - 1]}",
        }
        for i in range(1, 8)
    ]
    for p in pages:
        p["text"] += "\n\nPage Footer Text"
    cleaned, report = clean_pages(pages)
    assert report["stripped_lines"] == 7
    for cp in cleaned:
        assert "Page Footer Text" not in cp["text"]
        assert "\n\n" in cp["text"]  # blank line still separates the two real paragraphs

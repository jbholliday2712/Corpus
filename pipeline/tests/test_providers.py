from corpus.providers import _detect_repetition


def test_no_repetition_returns_text_unchanged():
    text = "Intro paragraph.\n\nSecond distinct paragraph.\n\nThird distinct paragraph."
    assert _detect_repetition(text) == text


def test_exactly_two_repeats_is_not_truncated():
    # "more than twice in a row" means 3+ occurrences; two is left alone.
    text = "| Zone | Device |\n| 1 | Detector |\n\n| Zone | Device |\n| 1 | Detector |"
    assert _detect_repetition(text) == text


def test_exactly_two_repeats_with_a_preceding_paragraph_is_not_truncated():
    intro = "Zone Table"
    table = "| Zone | Device |\n| 1 | Detector |"
    text = "\n\n".join([intro, table, table])
    assert _detect_repetition(text) == text


def test_same_paragraph_repeated_three_times_is_truncated_to_one_copy():
    table = "| Zone | Device |\n| 1 | Detector |\n| 2 | Detector |"
    text = "\n\n".join([table] * 3)
    result = _detect_repetition(text)
    assert result == table
    assert result.count("| Zone | Device |") == 1


def test_repetition_after_legitimate_preamble_keeps_preamble_and_one_copy():
    intro = "Zone Table"
    table = "| Zone | Device |\n| 1 | Detector |"
    text = "\n\n".join([intro, table, table, table, table])
    result = _detect_repetition(text)
    assert result == f"{intro}\n\n{table}"


def test_two_paragraph_cycle_repeating_three_times_is_truncated():
    a, b = "Step 1: power on the panel.", "Step 2: confirm zone LEDs illuminate."
    text = "\n\n".join([a, b] * 3)
    result = _detect_repetition(text)
    assert result == f"{a}\n\n{b}"


def test_whitespace_only_variant_counts_as_near_exact_repeat():
    base = "| Zone 1 | Smoke Detector | Addr 001 |"
    variants = [base, base + "  ", "  " + base + "\t"]
    text = "\n\n".join(variants)
    result = _detect_repetition(text)
    assert result == base


def test_sequentially_different_rows_are_not_treated_as_repeats():
    # Rows that differ by an incrementing digit are genuinely distinct
    # content, not a repetition loop, even though they look very similar —
    # a fuzzy/similarity match would wrongly truncate a real table here.
    rows = [f"| Zone {i} | Detector | Addr {i:03d} |" for i in range(3)]
    text = "\n\n".join(rows)
    assert _detect_repetition(text) == text


def test_long_legitimate_table_with_no_repetition_is_untouched():
    rows = [f"| Zone {i} | Detector | Addr {i:03d} |" for i in range(40)]
    text = "\n\n".join(rows)
    assert _detect_repetition(text) == text


def test_short_output_is_returned_unchanged():
    text = "Just one paragraph."
    assert _detect_repetition(text) == text

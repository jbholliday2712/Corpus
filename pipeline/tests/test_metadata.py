import pytest

from corpus.metadata import _parse_metadata_response


def test_parses_plain_json():
    raw = (
        '{"manufacturer": "CTec", "panel_model": "XFP", '
        '"doc_type": "engineering_manual", "revision": "Rev 4"}'
    )
    result = _parse_metadata_response(raw)
    assert result == {
        "manufacturer": "CTec",
        "panel_model": "XFP",
        "doc_type": "engineering_manual",
        "revision": "Rev 4",
    }


def test_parses_json_wrapped_in_markdown_code_fence():
    raw = (
        "```json\n"
        '{"manufacturer": "Pyronix", "panel_model": "Enforcer", '
        '"doc_type": "install_manual", "revision": null}\n'
        "```"
    )
    result = _parse_metadata_response(raw)
    assert result["manufacturer"] == "Pyronix"
    assert result["doc_type"] == "install_manual"
    assert result["revision"] is None


def test_tolerates_prose_around_the_json_object():
    raw = (
        "Sure, here is the metadata you requested:\n\n"
        '{"manufacturer": "CTec", "panel_model": "XFP", '
        '"doc_type": "datasheet", "revision": null}\n\n'
        "Let me know if you need anything else!"
    )
    result = _parse_metadata_response(raw)
    assert result["manufacturer"] == "CTec"
    assert result["doc_type"] == "datasheet"


def test_unrecognized_doc_type_is_coerced_to_other():
    raw = '{"manufacturer": "CTec", "panel_model": "XFP", "doc_type": "brochure", "revision": null}'
    result = _parse_metadata_response(raw)
    assert result["doc_type"] == "other"


def test_missing_doc_type_is_coerced_to_other():
    raw = '{"manufacturer": "CTec", "panel_model": "XFP", "revision": null}'
    result = _parse_metadata_response(raw)
    assert result["doc_type"] == "other"


def test_missing_fields_default_to_none():
    raw = '{"doc_type": "user_manual"}'
    result = _parse_metadata_response(raw)
    assert result["manufacturer"] is None
    assert result["panel_model"] is None
    assert result["revision"] is None


def test_empty_string_fields_become_none():
    raw = '{"manufacturer": "", "panel_model": "XFP", "doc_type": "other", "revision": ""}'
    result = _parse_metadata_response(raw)
    assert result["manufacturer"] is None
    assert result["revision"] is None


def test_unparseable_response_raises_value_error():
    with pytest.raises(ValueError):
        _parse_metadata_response("Sorry, I can't help with that.")

"""Stage 2: infer manufacturer/panel/doc_type/revision from the first pages.

`_parse_metadata_response` is the pure, DB-free parsing/validation logic —
the thing worth unit-testing. `infer_metadata` is the thin DB/file/NIM
wrapper around it.
"""

import json
import re

_METADATA_PAGE_COUNT = 3

_ALLOWED_DOC_TYPES = {
    "engineering_manual",
    "install_manual",
    "datasheet",
    "user_manual",
    "other",
}

_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)
_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)

METADATA_PROMPT_TEMPLATE = (
    "Identify manufacturer, panel model, document type "
    "(engineering_manual / install_manual / datasheet / user_manual / other), "
    "and revision if present. Respond ONLY as JSON: "
    '{{"manufacturer": ..., "panel_model": ..., "doc_type": ..., "revision": ...}}'
    "\n\n{pages_text}"
)


def _parse_metadata_response(raw: str) -> dict:
    """Parse the NIM LLM's metadata JSON. Tolerates markdown code fences and
    extra prose around the object. A doc_type outside the allowed set is
    coerced to 'other' rather than raising — this pipeline is NOT PICKY, and
    a human confirms metadata in the review UI anyway."""
    text = _CODE_FENCE_RE.sub("", raw.strip()).strip()
    match = _JSON_OBJECT_RE.search(text)
    if not match:
        raise ValueError(f"no JSON object found in metadata response: {raw!r}")
    data = json.loads(match.group(0))

    doc_type = data.get("doc_type")
    if doc_type not in _ALLOWED_DOC_TYPES:
        doc_type = "other"

    return {
        "manufacturer": data.get("manufacturer") or None,
        "panel_model": data.get("panel_model") or None,
        "doc_type": doc_type,
        "revision": data.get("revision") or None,
    }


def infer_metadata(document_id: str) -> dict:
    from corpus import db
    from corpus.extract import read_page
    from corpus.paths import WORK_DIR
    from corpus.providers import NIMClient

    doc_row = db.get_document(document_id)
    if doc_row is None:
        raise ValueError(f"no document {document_id}")

    # Resumable: don't re-spend an LLM call on retry if this already ran.
    if doc_row.get("doc_type"):
        return {
            "manufacturer": doc_row.get("manufacturer"),
            "panel_model": doc_row.get("panel_model"),
            "doc_type": doc_row.get("doc_type"),
            "revision": doc_row.get("revision"),
        }

    pages_dir = WORK_DIR / doc_row["file_hash"] / "pages"
    page_paths = sorted(pages_dir.glob("*.md"))[:_METADATA_PAGE_COUNT]
    if not page_paths:
        raise FileNotFoundError(f"no extracted pages in {pages_dir} (run extract first)")

    pages_text = "\n\n".join(read_page(p)[1] for p in page_paths)

    client = NIMClient()
    raw = client.llm_complete(METADATA_PROMPT_TEMPLATE.format(pages_text=pages_text))
    metadata = _parse_metadata_response(raw)

    db.update_document(document_id, metadata)
    return metadata

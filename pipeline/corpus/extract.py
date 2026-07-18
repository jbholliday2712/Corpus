"""Stage 1: per-page extraction. M2 is the text-only path (PyMuPDF on every
page); triage + vision fallback for scanned/table pages lands in M3."""

import pymupdf

from corpus import db
from corpus.paths import STORE_DIR, WORK_DIR


def extract_document(document_id: str) -> int:
    """Render every page's text layer to work/<hash>/pages/NNN.md. Resumable:
    a page already written on disk is left alone, so a crash mid-document
    just re-runs the pages that didn't make it. Returns the page count."""
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

    pdf = pymupdf.open(pdf_path)
    try:
        page_count = pdf.page_count
        for i in range(page_count):
            out_path = pages_dir / f"{i + 1:03d}.md"
            if out_path.exists():
                continue
            out_path.write_text(pdf[i].get_text(), encoding="utf-8")
    finally:
        pdf.close()

    db.update_document(document_id, {"page_count": page_count})
    return page_count

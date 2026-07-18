"""Reprocess / hard-reset a single document. Importable pipeline logic used
by both `corpus reprocess` / `corpus reset` (cli.py) and the review UI's
/api/documents/[id]/reprocess and /api/documents/[id]/reset routes — the CLI
commands are thin wrappers around the two functions here, same split as
every other stage (extract.py, clean.py, chunk.py, embed.py) already uses.

`reprocess_document` reuses each stage's own resumability guard by first
tearing down exactly the state that guard checks (delete_chunks defeats
chunk_document's "skip if count_chunks() > 0"; clear_chunk_embeddings
defeats embed_document's "only touch null-embedding chunks") and then
calling the same stage function `_process` calls. Since every stage's write
is a single bulk insert/update, there is no partially-torn-down state to
worry about after a crash: re-running reprocess_document from the same
from_stage always starts from "0 chunks" or "N chunks", never "half of N",
so it's safe to call again after a failure without any special recovery
path.

Furniture restore choices (furniture_overrides.json) live on disk per
file_hash and are read fresh by clean_document on every call, so a 'clean'
reprocess automatically keeps them. Chunk-level retrieval_override toggles
live on chunk rows, which 'clean' and 'chunk' reprocessing both delete and
recreate — the review UI is responsible for warning about that loss before
the request is made; this module has no way to preserve them since the new
chunks are not the same rows.
"""

from corpus import chunk, clean, db, embed

FROM_STAGES = ("clean", "chunk", "embed")


def reprocess_document(document_id: str, from_stage: str) -> dict:
    """Re-run a document's pipeline from `from_stage` onward:

    - 'clean': force-regenerate cleaned pages (same as restore-furniture),
      then delete + rebuild chunks, then re-embed. Subject to the same
      cleaning safety rail as a normal run — if triggered, stops before
      chunking/embedding, same as `_process`.
    - 'chunk': keep the existing cleaned pages, delete + rebuild chunks,
      then re-embed.
    - 'embed': keep the existing chunks, clear their embeddings, re-embed.

    Sets status='queued' up front so the review UI's polling shows activity
    immediately, even during the part of 'clean' (clean_document itself
    sets no in-progress status) before chunk_document/embed_document take
    over and set chunking/embedding themselves. On any failure, mirrors
    every other stage entrypoint: status='failed' + error_message, and
    re-raise so the caller (CLI or API route) knows it did not succeed.
    """
    if from_stage not in FROM_STAGES:
        raise ValueError(f"from_stage must be one of {FROM_STAGES}, got {from_stage!r}")

    doc_row = db.get_document(document_id)
    if doc_row is None:
        raise ValueError(f"no document {document_id}")

    db.update_document(document_id, {"status": "queued", "error_message": None})

    try:
        if from_stage == "clean":
            report = clean.clean_document(document_id, force=True)
            if report.get("safety_rail_triggered"):
                return report
            db.delete_chunks(document_id)
            chunk.chunk_document(document_id)
            embed.embed_document(document_id)
            return report

        if from_stage == "chunk":
            db.delete_chunks(document_id)
            chunk.chunk_document(document_id)
            embed.embed_document(document_id)
            return {}

        db.clear_chunk_embeddings(document_id)
        embed.embed_document(document_id)
        return {}
    except Exception as exc:  # noqa: BLE001
        db.update_document(document_id, {"status": "failed", "error_message": str(exc)})
        raise


def reset_hard(document_id: str) -> None:
    """Delete the document row (cascades to its chunks per the FK), then
    remove work/<hash>/ and store/<hash>.pdf so the PDF must be re-dropped
    into inbox/ to reprocess from scratch. Looks up the row first since the
    file_hash is needed to find the filesystem state, and deletes the DB row
    only after resolving that — if the filesystem cleanup fails, the caller
    at least still has a document_id to retry against."""
    import shutil

    from corpus.paths import STORE_DIR, WORK_DIR

    doc_row = db.get_document(document_id)
    if doc_row is None:
        raise ValueError(f"no document {document_id}")

    file_hash = doc_row["file_hash"]
    db.delete_document(document_id)

    work_dir = WORK_DIR / file_hash
    if work_dir.exists():
        shutil.rmtree(work_dir)

    pdf_path = STORE_DIR / f"{file_hash}.pdf"
    if pdf_path.exists():
        pdf_path.unlink()

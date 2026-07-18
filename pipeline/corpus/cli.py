"""CLI entrypoints: check, ingest, watch, process, retry, status."""

import json
import time
from pathlib import Path

import click

from corpus import chunk, clean, db, embed, extract, intake, metadata
from corpus import reprocess as reprocess_pipeline
from corpus.config import load_settings
from corpus.paths import INBOX_DIR
from corpus.providers import NIMClient


def _process(document_id: str) -> None:
    """Run extract -> metadata -> clean -> chunk -> embed for one document.
    Every stage is resumable (extract/clean/chunk/embed/metadata each skip
    work already done), so this is also what `corpus retry` calls —
    re-running it on a document that got partway through just picks up
    where it left off. Metadata inference is best-effort: it's a
    human-reviewed enrichment, not part of the core content pipeline, so a
    bad/missing NIM_LLM_MODEL or a malformed LLM response is logged and
    skipped rather than failing the whole document. Cleaning's safety rail
    (STATUS.md §4) can stop the pipeline early — if >15% of a document's
    lines get stripped as furniture, that's set to status='review' with a
    warning instead of proceeding to chunk/embed automatically, since the
    heuristic likely misfired and shouldn't be trusted with NIM quota until
    a human looks at the Cleaning tab. On any other failure, mark the
    document `failed` with the error message and re-raise so the caller
    decides whether to keep going (matches STATUS.md's failure handling:
    one bad PDF must not kill a `watch` loop processing others)."""
    try:
        pages = extract.extract_document(document_id)
        click.echo(f"  extracted {pages} pages")
        try:
            meta = metadata.infer_metadata(document_id)
            click.echo(f"  inferred metadata: {meta}")
        except Exception as exc:  # noqa: BLE001
            click.echo(f"  metadata inference skipped: {exc}")

        report = clean.clean_document(document_id)
        click.echo(
            f"  cleaned: {report.get('stripped_lines', 0)}/{report.get('total_lines', 0)} "
            f"lines stripped ({report.get('stripped_pct', 0)}%)"
        )
        if report.get("safety_rail_triggered"):
            click.echo(
                "  stripped-line ratio exceeded the safety threshold — stopped for "
                "review, not chunking/embedding automatically"
            )
            return

        n_chunks = chunk.chunk_document(document_id)
        click.echo(f"  chunked into {n_chunks} chunks")
        n_embedded = embed.embed_document(document_id)
        click.echo(f"  embedded {n_embedded} chunks -> status=review")
        db.update_document(document_id, {"error_message": None})
    except Exception as exc:  # noqa: BLE001
        db.update_document(document_id, {"status": "failed", "error_message": str(exc)})
        raise


@click.group()
def main():
    """Corpus manual ingestion pipeline."""


@main.command()
def check():
    """Verify .env is populated, Supabase is reachable, and the embedding
    endpoint responds (prints the vector dimension so it can be checked
    against supabase/migrations/)."""
    settings = load_settings()
    missing = settings.missing()
    if missing:
        click.echo(f"Missing env vars: {', '.join(missing)}")
    else:
        click.echo("All env vars set.")

    if settings.supabase_url and settings.supabase_service_key:
        try:
            db.ping()
            click.echo("Supabase: OK (documents table reachable)")
        except Exception as exc:  # noqa: BLE001
            click.echo(f"Supabase: FAILED ({exc})")
    else:
        click.echo("Supabase: skipped (SUPABASE_URL / SUPABASE_SERVICE_KEY not set)")

    if settings.nim_api_key and settings.nim_embed_model:
        try:
            client = NIMClient()
            vectors = client.embed(["fire alarm control panel"], input_type="passage")
            dims = len(vectors[0])
            click.echo(f"NIM embed: OK, model={settings.nim_embed_model}, dims={dims}")
            if dims != 1024:
                click.echo(
                    f"WARNING: supabase/migrations declares vector(1024) but this "
                    f"model returns {dims} dims. Add a migration to alter the column before relying on it."
                )
        except Exception as exc:  # noqa: BLE001
            click.echo(f"NIM embed: FAILED ({exc})")
    else:
        click.echo("NIM embed: skipped (NIM_API_KEY / NIM_EMBED_MODEL not set)")


@main.command()
@click.argument("path", type=click.Path(exists=True, path_type=Path))
@click.option(
    "--json",
    "as_json",
    is_flag=True,
    help="Print {id, duplicate, file_name} as JSON instead of a human-readable line "
    "(for scripted callers, e.g. review-ui's upload action).",
)
def ingest(path: Path, as_json: bool):
    """Ingest a single PDF: hash, copy to store/, insert a `documents` row."""
    row = intake.ingest(path)
    if as_json:
        click.echo(
            json.dumps(
                {
                    "id": row["id"],
                    "duplicate": bool(row.get("duplicate")),
                    "file_name": path.name,
                }
            )
        )
    elif row.get("duplicate"):
        click.echo(f"Duplicate (already ingested as {row['id']}): {path.name}")
    else:
        click.echo(f"Ingested {path.name} -> document {row['id']} (status=queued)")


@main.command(name="ingest-dir")
@click.argument("directory", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option(
    "--process/--no-process",
    default=False,
    help="Also run extract->metadata->clean->chunk->embed for each newly-ingested "
    "document, one at a time (can take a while for many/vision-heavy PDFs). "
    "Without this, documents are left status=queued for `corpus watch` (or a "
    "later `corpus ingest-dir --process`) to pick up.",
)
def ingest_dir(directory: Path, process: bool):
    """Bulk-ingest every PDF directly inside DIRECTORY in one shot — the
    one-shot alternative to dropping files into inbox/ and leaving `corpus
    watch` running. Duplicates (by content hash) are skipped like a normal
    ingest; one bad PDF is reported and skipped rather than aborting the
    rest of the batch, matching `watch`'s per-file failure handling."""
    pdfs = sorted(directory.glob("*.pdf"))
    if not pdfs:
        click.echo(f"No PDFs found in {directory}")
        return

    ingested_ids: list[str] = []
    duplicates = 0
    failed = 0
    for pdf in pdfs:
        try:
            row = intake.ingest(pdf)
        except Exception as exc:  # noqa: BLE001
            click.echo(f"  FAILED to ingest {pdf.name}: {exc}")
            failed += 1
            continue
        if row.get("duplicate"):
            click.echo(f"  Duplicate (already ingested as {row['id']}): {pdf.name}")
            duplicates += 1
            continue
        click.echo(f"  Ingested {pdf.name} -> document {row['id']} (status=queued)")
        ingested_ids.append(row["id"])

    click.echo(
        f"\n{len(ingested_ids)} ingested, {duplicates} duplicate(s), {failed} failed, "
        f"out of {len(pdfs)} PDF(s) found."
    )

    if process and ingested_ids:
        click.echo("\nProcessing...")
        for document_id in ingested_ids:
            try:
                _process(document_id)
            except Exception as exc:  # noqa: BLE001
                click.echo(f"  FAILED to process {document_id}: {exc}")


@main.command(name="embed-query")
@click.argument("text")
def embed_query(text: str):
    """Embed a single string with input_type='query'; prints {"embedding": [...]}
    as JSON. Used by review-ui's search-and-highlight feature to preview what
    the future chat app would retrieve for a given question — same embedding
    model, same NIMClient, via providers.py rather than duplicating the NIM
    call in TypeScript."""
    client = NIMClient()
    vector = client.embed([text], input_type="query")[0]
    click.echo(json.dumps({"embedding": vector}))


@main.command()
@click.argument("document_id")
def process(document_id: str):
    """Run extract -> metadata -> clean -> chunk -> embed for a document."""
    try:
        _process(document_id)
    except Exception as exc:  # noqa: BLE001
        raise click.ClickException(f"Processing failed: {exc}")


@main.command()
@click.option("--inbox", type=click.Path(path_type=Path), default=INBOX_DIR)
@click.option("--interval", default=5, help="Seconds between inbox scans.")
def watch(inbox: Path, interval: int):
    """Watch ./inbox/, ingest any PDF dropped there, and run the full
    extract -> metadata -> clean -> chunk -> embed pipeline on it. One bad
    PDF is logged and skipped; the loop keeps going."""
    inbox.mkdir(parents=True, exist_ok=True)
    click.echo(f"Watching {inbox} (Ctrl+C to stop)...")
    seen: set[str] = set()
    try:
        while True:
            for pdf in sorted(inbox.glob("*.pdf")):
                if pdf.name in seen:
                    continue
                seen.add(pdf.name)
                row = intake.ingest(pdf)
                if row.get("duplicate"):
                    click.echo(f"Duplicate: {pdf.name}")
                    continue
                click.echo(f"Ingested {pdf.name} -> {row['id']}")
                try:
                    _process(row["id"])
                except Exception as exc:  # noqa: BLE001
                    click.echo(f"  FAILED: {exc}")
            time.sleep(interval)
    except KeyboardInterrupt:
        click.echo("Stopped.")


@main.command()
@click.argument("document_id")
def retry(document_id: str):
    """Re-run a document from its last completed stage. Extract skips pages
    already written, metadata skips if already inferred, clean skips
    regenerating cleaned pages if they already exist (but always
    re-evaluates the safety-rail decision, so a "proceed anyway" override
    set via the review UI actually takes effect here), chunk skips if
    chunks already exist, embed only fills in missing embeddings — so this
    is safe to run on a `failed` document without redoing NIM calls (or
    burning quota) for work that already succeeded before the failure."""
    doc_row = db.get_document(document_id)
    if doc_row is None:
        raise click.ClickException(f"no document {document_id}")
    try:
        _process(document_id)
    except Exception as exc:  # noqa: BLE001
        raise click.ClickException(f"Retry failed: {exc}")
    click.echo(f"Retried {document_id} -> status=review")


@main.command(name="restore-furniture")
@click.argument("document_id")
@click.argument("normalized_line")
def restore_furniture(document_id: str, normalized_line: str):
    """Mark a normalized furniture line (as it appears in furniture.json /
    the review UI's Cleaning tab) as never-strip for this document, then
    force a re-clean -> re-chunk -> re-embed. Unlike `retry`, this always
    regenerates the cleaned pages (the override changes what gets
    stripped) and always replaces existing chunks (the old ones were built
    from text that's about to change) rather than skipping already-done
    work."""
    from corpus.paths import WORK_DIR

    doc_row = db.get_document(document_id)
    if doc_row is None:
        raise click.ClickException(f"no document {document_id}")

    overrides_path = WORK_DIR / doc_row["file_hash"] / "furniture_overrides.json"
    overrides: set[str] = set()
    if overrides_path.exists():
        overrides = set(json.loads(overrides_path.read_text(encoding="utf-8")))
    overrides.add(normalized_line)
    overrides_path.parent.mkdir(parents=True, exist_ok=True)
    overrides_path.write_text(json.dumps(sorted(overrides)), encoding="utf-8")

    try:
        report = clean.clean_document(document_id, force=True)
        click.echo(
            f"  re-cleaned: {report.get('stripped_lines', 0)}/{report.get('total_lines', 0)} "
            f"lines stripped ({report.get('stripped_pct', 0)}%)"
        )
        if report.get("safety_rail_triggered"):
            click.echo("  still over the safety threshold — stopped for review")
            return

        db.delete_chunks(document_id)
        n_chunks = chunk.chunk_document(document_id)
        click.echo(f"  re-chunked into {n_chunks} chunks")
        n_embedded = embed.embed_document(document_id)
        click.echo(f"  re-embedded {n_embedded} chunks -> status=review")
        db.update_document(document_id, {"error_message": None})
    except Exception as exc:  # noqa: BLE001
        db.update_document(document_id, {"status": "failed", "error_message": str(exc)})
        raise click.ClickException(f"Restore failed: {exc}")


@main.command(name="reprocess")
@click.argument("document_id")
@click.option(
    "--from-stage",
    "from_stage",
    type=click.Choice(reprocess_pipeline.FROM_STAGES),
    default="clean",
    help="Stage to restart from: clean (re-clean + re-chunk + re-embed), "
    "chunk (re-chunk + re-embed), or embed (re-embed only).",
)
def reprocess_cmd(document_id: str, from_stage: str):
    """Re-run a document's pipeline from a chosen stage onward. Thin
    wrapper around corpus.reprocess.reprocess_document — see that module
    for the exact idempotency guarantees per stage."""
    doc_row = db.get_document(document_id)
    if doc_row is None:
        raise click.ClickException(f"no document {document_id}")
    try:
        report = reprocess_pipeline.reprocess_document(document_id, from_stage)
    except Exception as exc:  # noqa: BLE001
        raise click.ClickException(f"Reprocess failed: {exc}")
    if report.get("safety_rail_triggered"):
        click.echo(
            f"Reprocessed {document_id} from '{from_stage}' -> stopped for review "
            "(cleaning safety rail triggered)"
        )
    else:
        click.echo(f"Reprocessed {document_id} from '{from_stage}' -> status=review")


@main.command(name="reset")
@click.argument("document_id")
@click.option(
    "--hard",
    "hard",
    is_flag=True,
    required=True,
    help="Required confirmation flag: deletes the document row (cascades to "
    "chunks), work/<hash>/, and store/<hash>.pdf.",
)
def reset_cmd(document_id: str, hard: bool):
    """Hard reset a document: delete its DB row, extracted pages, and
    stored PDF. The PDF must be re-dropped into inbox/ to reprocess it."""
    try:
        reprocess_pipeline.reset_hard(document_id)
    except Exception as exc:  # noqa: BLE001
        raise click.ClickException(f"Reset failed: {exc}")
    click.echo(f"Reset {document_id}: document row, chunks, work/, and store/ PDF deleted")


@main.command(name="status")
def status_cmd():
    """List documents and their pipeline status."""
    client = db.get_client()
    res = (
        client.table("documents")
        .select("id,file_name,status,error_message")
        .order("created_at", desc=True)
        .execute()
    )
    if not res.data:
        click.echo("No documents yet.")
        return
    for doc in res.data:
        line = f"{doc['id']}  {doc['status']:<10}  {doc['file_name']}"
        if doc.get("error_message"):
            line += f"  ERROR: {doc['error_message']}"
        click.echo(line)


if __name__ == "__main__":
    main()

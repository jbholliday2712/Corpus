"""CLI entrypoints: check, ingest, watch, process, retry, status."""

import time
from pathlib import Path

import click

from corpus import chunk, db, embed, extract, intake, metadata
from corpus.config import load_settings
from corpus.paths import INBOX_DIR
from corpus.providers import NIMClient


def _process(document_id: str) -> None:
    """Run extract -> metadata -> chunk -> embed for one document. Every
    stage is resumable (extract/chunk/embed/metadata each skip work already
    done), so this is also what `corpus retry` calls — re-running it on a
    document that got partway through just picks up where it left off.
    Metadata inference is best-effort: it's a human-reviewed enrichment, not
    part of the core content pipeline, so a bad/missing NIM_LLM_MODEL or a
    malformed LLM response is logged and skipped rather than failing the
    whole document. On any other failure, mark the document `failed` with
    the error message and re-raise so the caller decides whether to keep
    going (matches STATUS.md's failure handling: one bad PDF must not kill a
    `watch` loop processing others)."""
    try:
        pages = extract.extract_document(document_id)
        click.echo(f"  extracted {pages} pages")
        try:
            meta = metadata.infer_metadata(document_id)
            click.echo(f"  inferred metadata: {meta}")
        except Exception as exc:  # noqa: BLE001
            click.echo(f"  metadata inference skipped: {exc}")
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
def ingest(path: Path):
    """Ingest a single PDF: hash, copy to store/, insert a `documents` row."""
    row = intake.ingest(path)
    if row.get("duplicate"):
        click.echo(f"Duplicate (already ingested as {row['id']}): {path.name}")
    else:
        click.echo(f"Ingested {path.name} -> document {row['id']} (status=queued)")


@main.command()
@click.argument("document_id")
def process(document_id: str):
    """Run extract -> metadata -> chunk -> embed for a document."""
    try:
        _process(document_id)
    except Exception as exc:  # noqa: BLE001
        raise click.ClickException(f"Processing failed: {exc}")


@main.command()
@click.option("--inbox", type=click.Path(path_type=Path), default=INBOX_DIR)
@click.option("--interval", default=5, help="Seconds between inbox scans.")
def watch(inbox: Path, interval: int):
    """Watch ./inbox/, ingest any PDF dropped there, and run the full
    extract -> metadata -> chunk -> embed pipeline on it. One bad PDF is
    logged and skipped; the loop keeps going."""
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
    already written, metadata skips if already inferred, chunk skips if
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

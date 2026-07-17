"""CLI entrypoints: check, ingest, watch, retry, status."""

import time
from pathlib import Path

import click

from corpus import db, intake
from corpus.config import load_settings
from corpus.providers import NIMClient


@click.group()
def main():
    """Corpus manual ingestion pipeline."""


@main.command()
def check():
    """Verify .env is populated, Supabase is reachable, and the embedding
    endpoint responds (prints the vector dimension so it can be checked
    against db/schema.sql)."""
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
                    f"WARNING: db/schema.sql declares vector(1024) but this "
                    f"model returns {dims} dims. Edit the schema before applying it."
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
@click.option(
    "--inbox",
    type=click.Path(path_type=Path),
    default=Path(__file__).resolve().parent.parent.parent / "inbox",
)
@click.option("--interval", default=5, help="Seconds between inbox scans.")
def watch(inbox: Path, interval: int):
    """Watch ./inbox/ and ingest any PDF dropped there."""
    inbox.mkdir(parents=True, exist_ok=True)
    click.echo(f"Watching {inbox} (Ctrl+C to stop)...")
    seen: set[str] = set()
    try:
        while True:
            for pdf in sorted(inbox.glob("*.pdf")):
                if pdf.name in seen:
                    continue
                row = intake.ingest(pdf)
                seen.add(pdf.name)
                if row.get("duplicate"):
                    click.echo(f"Duplicate: {pdf.name}")
                else:
                    click.echo(f"Ingested {pdf.name} -> {row['id']}")
            time.sleep(interval)
    except KeyboardInterrupt:
        click.echo("Stopped.")


@main.command()
@click.argument("document_id")
def retry(document_id: str):
    """Re-run a failed document from its last good stage. (lands with M4 status machine)"""
    raise click.ClickException("retry lands in M4 once the status machine is built")


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

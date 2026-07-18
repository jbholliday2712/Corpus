"""Supabase access. All table reads/writes go through here."""

from supabase import Client, create_client

from corpus.config import load_settings


class DBError(RuntimeError):
    pass


def get_client() -> Client:
    settings = load_settings()
    if not settings.supabase_url or not settings.supabase_service_key:
        raise DBError("SUPABASE_URL / SUPABASE_SERVICE_KEY are not set")
    return create_client(settings.supabase_url, settings.supabase_service_key)


def ping() -> bool:
    """Cheap connectivity check used by `corpus check`."""
    client = get_client()
    client.table("documents").select("id").limit(1).execute()
    return True


def get_document(document_id: str) -> dict | None:
    client = get_client()
    res = client.table("documents").select("*").eq("id", document_id).limit(1).execute()
    return res.data[0] if res.data else None


def get_document_by_hash(file_hash: str) -> dict | None:
    client = get_client()
    res = (
        client.table("documents")
        .select("*")
        .eq("file_hash", file_hash)
        .limit(1)
        .execute()
    )
    return res.data[0] if res.data else None


def insert_document(row: dict) -> dict:
    client = get_client()
    res = client.table("documents").insert(row).execute()
    return res.data[0]


def update_document(document_id: str, fields: dict) -> dict:
    client = get_client()
    res = (
        client.table("documents").update(fields).eq("id", document_id).execute()
    )
    return res.data[0]


def insert_chunks(rows: list[dict]) -> list[dict]:
    client = get_client()
    res = client.table("chunks").insert(rows).execute()
    return res.data


def delete_chunks(document_id: str) -> None:
    """Used by `corpus restore-furniture`: cleaning changes what text gets
    chunked, so the old chunk rows (and any embeddings on them) must be
    replaced, not left to linger alongside a fresh set."""
    client = get_client()
    client.table("chunks").delete().eq("document_id", document_id).execute()


def delete_document(document_id: str) -> None:
    """Used by `corpus reset --hard`. ON DELETE CASCADE on
    chunks.document_id (see supabase/migrations) takes care of the chunk
    rows — the caller is still responsible for the filesystem (work/<hash>/,
    store/<hash>.pdf), which this function knows nothing about."""
    client = get_client()
    client.table("documents").delete().eq("id", document_id).execute()


def clear_chunk_embeddings(document_id: str) -> None:
    """Used by `corpus reprocess --from-stage embed`: embed_document only
    fills in chunks with a null embedding, so a genuine re-embed (e.g. after
    switching NIM_EMBED_MODEL) has to null every existing embedding first or
    embed_document would see nothing to do."""
    client = get_client()
    client.table("chunks").update({"embedding": None}).eq(
        "document_id", document_id
    ).execute()


def count_chunks(document_id: str) -> int:
    client = get_client()
    res = (
        client.table("chunks")
        .select("id", count="exact")
        .eq("document_id", document_id)
        .execute()
    )
    return res.count or 0


def get_chunks_missing_embedding(document_id: str) -> list[dict]:
    client = get_client()
    res = (
        client.table("chunks")
        .select("*")
        .eq("document_id", document_id)
        .is_("embedding", "null")
        .execute()
    )
    return res.data


def update_chunk_embedding(chunk_id: str, embedding: list[float]) -> None:
    client = get_client()
    client.table("chunks").update({"embedding": embedding}).eq(
        "id", chunk_id
    ).execute()


def set_setting(key: str, value: str) -> None:
    client = get_client()
    client.table("settings").upsert({"key": key, "value": value}).execute()


def get_setting(key: str) -> str | None:
    client = get_client()
    res = client.table("settings").select("value").eq("key", key).limit(1).execute()
    return res.data[0]["value"] if res.data else None

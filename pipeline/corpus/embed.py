"""Stage 4: embed chunks missing an embedding, in batches, resumable
(re-queries for null-embedding chunks each batch, so a crash mid-document
only re-does the unembedded remainder)."""

from corpus import db
from corpus.providers import NIMClient

BATCH_SIZE = 16


def embed_document(document_id: str) -> int:
    db.update_document(document_id, {"status": "embedding"})
    client = NIMClient()

    embedded = 0
    while True:
        pending = db.get_chunks_missing_embedding(document_id)
        if not pending:
            break
        batch = pending[:BATCH_SIZE]
        vectors = client.embed([c["content"] for c in batch], input_type="passage")
        for chunk, vector in zip(batch, vectors, strict=True):
            db.update_chunk_embedding(chunk["id"], vector)
        embedded += len(batch)

    db.update_document(document_id, {"status": "review"})
    return embedded

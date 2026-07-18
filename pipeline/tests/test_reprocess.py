"""reprocess_document / reset_hard are I/O-heavy (DB + filesystem), so these
tests monkeypatch the corpus.db / corpus.clean / corpus.chunk / corpus.embed
functions reprocess.py calls and assert on *call order* and the resulting
status/error_message writes, the same way the underlying real functions
would be exercised against a real Supabase project on the user's machine
(no real Supabase/NIM available in this sandbox — see STATUS.md)."""

import pytest

from corpus import reprocess


class FakeDB:
    """Records every call so tests can assert both what happened and the
    order it happened in — order matters here (e.g. delete_chunks must run
    before chunk_document, or chunk_document's "skip if count_chunks() > 0"
    resumability guard would treat the old chunks as already-done work)."""

    def __init__(self, doc_row):
        self.doc_row = doc_row
        self.calls: list[tuple] = []
        self.deleted_chunks_for: list[str] = []
        self.cleared_embeddings_for: list[str] = []
        self.deleted_documents: list[str] = []
        self.updates: list[tuple[str, dict]] = []

    def get_document(self, document_id):
        self.calls.append(("get_document", document_id))
        if document_id != self.doc_row["id"]:
            return None
        return self.doc_row

    def update_document(self, document_id, fields):
        self.calls.append(("update_document", document_id, fields))
        self.updates.append((document_id, fields))
        return {**self.doc_row, **fields}

    def delete_chunks(self, document_id):
        self.calls.append(("delete_chunks", document_id))
        self.deleted_chunks_for.append(document_id)

    def clear_chunk_embeddings(self, document_id):
        self.calls.append(("clear_chunk_embeddings", document_id))
        self.cleared_embeddings_for.append(document_id)

    def delete_document(self, document_id):
        self.calls.append(("delete_document", document_id))
        self.deleted_documents.append(document_id)


@pytest.fixture
def doc_row():
    return {"id": "doc-1", "file_hash": "abc123", "status": "review"}


@pytest.fixture
def fake_db(monkeypatch, doc_row):
    fake = FakeDB(doc_row)
    monkeypatch.setattr(reprocess, "db", fake)
    return fake


def test_reprocess_from_clean_deletes_chunks_before_rechunking(monkeypatch, fake_db):
    calls = []
    monkeypatch.setattr(
        reprocess.clean,
        "clean_document",
        lambda document_id, force=False: calls.append(("clean", force)) or {
            "safety_rail_triggered": False,
            "stripped_pct": 3.0,
        },
    )
    monkeypatch.setattr(
        reprocess.chunk, "chunk_document", lambda document_id: calls.append(("chunk",)) or 5
    )
    monkeypatch.setattr(
        reprocess.embed, "embed_document", lambda document_id: calls.append(("embed",)) or 5
    )

    report = reprocess.reprocess_document("doc-1", "clean")

    assert report["safety_rail_triggered"] is False
    assert calls == [("clean", True), ("chunk",), ("embed",)]
    assert fake_db.deleted_chunks_for == ["doc-1"]
    # delete_chunks must happen strictly between clean and chunk.
    delete_index = fake_db.calls.index(("delete_chunks", "doc-1"))
    get_index = fake_db.calls.index(("get_document", "doc-1"))
    assert get_index < delete_index


def test_reprocess_from_clean_stops_on_safety_rail(monkeypatch, fake_db):
    monkeypatch.setattr(
        reprocess.clean,
        "clean_document",
        lambda document_id, force=False: {"safety_rail_triggered": True, "stripped_pct": 40.0},
    )
    chunk_called = []
    embed_called = []
    monkeypatch.setattr(reprocess.chunk, "chunk_document", lambda document_id: chunk_called.append(1))
    monkeypatch.setattr(reprocess.embed, "embed_document", lambda document_id: embed_called.append(1))

    report = reprocess.reprocess_document("doc-1", "clean")

    assert report["safety_rail_triggered"] is True
    assert chunk_called == []
    assert embed_called == []
    assert fake_db.deleted_chunks_for == []


def test_reprocess_from_chunk_skips_cleaning(monkeypatch, fake_db):
    clean_called = []
    monkeypatch.setattr(
        reprocess.clean, "clean_document", lambda document_id, force=False: clean_called.append(1)
    )
    chunk_called = []
    embed_called = []
    monkeypatch.setattr(
        reprocess.chunk, "chunk_document", lambda document_id: chunk_called.append(1) or 5
    )
    monkeypatch.setattr(
        reprocess.embed, "embed_document", lambda document_id: embed_called.append(1) or 5
    )

    reprocess.reprocess_document("doc-1", "chunk")

    assert clean_called == []
    assert fake_db.deleted_chunks_for == ["doc-1"]
    assert chunk_called == [1]
    assert embed_called == [1]


def test_reprocess_from_embed_clears_embeddings_and_keeps_chunks(monkeypatch, fake_db):
    chunk_called = []
    embed_called = []
    monkeypatch.setattr(reprocess.chunk, "chunk_document", lambda document_id: chunk_called.append(1))
    monkeypatch.setattr(
        reprocess.embed, "embed_document", lambda document_id: embed_called.append(1) or 5
    )

    reprocess.reprocess_document("doc-1", "embed")

    assert fake_db.deleted_chunks_for == []
    assert fake_db.cleared_embeddings_for == ["doc-1"]
    assert chunk_called == []
    assert embed_called == [1]


def test_reprocess_rejects_unknown_stage(fake_db):
    with pytest.raises(ValueError):
        reprocess.reprocess_document("doc-1", "extract")


def test_reprocess_raises_for_missing_document(fake_db):
    with pytest.raises(ValueError):
        reprocess.reprocess_document("nope", "clean")


def test_reprocess_sets_status_failed_on_exception(monkeypatch, fake_db):
    monkeypatch.setattr(
        reprocess.clean,
        "clean_document",
        lambda document_id, force=False: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    with pytest.raises(RuntimeError, match="boom"):
        reprocess.reprocess_document("doc-1", "clean")

    failed_updates = [
        fields for (_id, fields) in fake_db.updates if fields.get("status") == "failed"
    ]
    assert len(failed_updates) == 1
    assert failed_updates[0]["error_message"] == "boom"


def test_reprocess_sets_status_queued_before_running(monkeypatch, fake_db):
    monkeypatch.setattr(
        reprocess.clean,
        "clean_document",
        lambda document_id, force=False: {"safety_rail_triggered": False},
    )
    monkeypatch.setattr(reprocess.chunk, "chunk_document", lambda document_id: 1)
    monkeypatch.setattr(reprocess.embed, "embed_document", lambda document_id: 1)

    reprocess.reprocess_document("doc-1", "clean")

    first_update = fake_db.updates[0]
    assert first_update[1]["status"] == "queued"


def test_reset_hard_deletes_row_work_dir_and_pdf(monkeypatch, tmp_path, fake_db):
    work_dir = tmp_path / "work"
    store_dir = tmp_path / "store"
    doc_work_dir = work_dir / "abc123"
    doc_work_dir.mkdir(parents=True)
    (doc_work_dir / "furniture.json").write_text("{}", encoding="utf-8")
    store_dir.mkdir(parents=True)
    pdf_path = store_dir / "abc123.pdf"
    pdf_path.write_bytes(b"%PDF-1.4")

    monkeypatch.setattr("corpus.paths.WORK_DIR", work_dir)
    monkeypatch.setattr("corpus.paths.STORE_DIR", store_dir)

    reprocess.reset_hard("doc-1")

    assert fake_db.deleted_documents == ["doc-1"]
    assert not doc_work_dir.exists()
    assert not pdf_path.exists()


def test_reset_hard_raises_for_missing_document(fake_db):
    with pytest.raises(ValueError):
        reprocess.reset_hard("nope")


def test_reset_hard_tolerates_missing_filesystem_state(monkeypatch, tmp_path, fake_db):
    work_dir = tmp_path / "work"
    store_dir = tmp_path / "store"
    work_dir.mkdir()
    store_dir.mkdir()

    monkeypatch.setattr("corpus.paths.WORK_DIR", work_dir)
    monkeypatch.setattr("corpus.paths.STORE_DIR", store_dir)

    reprocess.reset_hard("doc-1")

    assert fake_db.deleted_documents == ["doc-1"]

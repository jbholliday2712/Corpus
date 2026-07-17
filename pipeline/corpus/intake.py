"""Stage 0: intake a PDF into store/ and register it in `documents`. (M2)"""

import hashlib
import shutil
from pathlib import Path

STORE_DIR = Path(__file__).resolve().parent.parent.parent / "store"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def ingest(path: Path) -> dict:
    """Hash the file, copy it into store/ content-addressed, and insert a
    `documents` row with status `queued`. Returns the inserted row, or the
    existing row (with a `duplicate: True` flag) if the hash is already known.
    """
    from corpus import db

    file_hash = sha256_file(path)
    existing = db.get_document_by_hash(file_hash)
    if existing:
        return {**existing, "duplicate": True}

    STORE_DIR.mkdir(parents=True, exist_ok=True)
    dest = STORE_DIR / f"{file_hash}.pdf"
    if not dest.exists():
        shutil.copy2(path, dest)

    row = db.insert_document(
        {
            "file_name": path.name,
            "file_hash": file_hash,
            "status": "queued",
        }
    )
    return {**row, "duplicate": False}

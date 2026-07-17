"""Chunking is the one thing worth unit-testing. Real cases land in M2."""

import pytest

from corpus.chunk import chunk_document


def test_chunk_document_not_yet_implemented():
    with pytest.raises(NotImplementedError):
        chunk_document("00000000-0000-0000-0000-000000000000")

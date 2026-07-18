"""CLI wiring tests using click.testing.CliRunner. No real Supabase/NIM in
this sandbox, so `intake.ingest`/`_process` are monkeypatched — the point
here is to verify argv/option parsing and orchestration (loop, duplicate
counting, one-bad-file-doesn't-abort-the-batch), not the real pipeline
stages, which already have their own dedicated tests."""

from pathlib import Path

from click.testing import CliRunner

from corpus import cli


def _touch_pdfs(dir_path: Path, names: list[str]) -> None:
    for name in names:
        (dir_path / name).write_bytes(b"%PDF-1.4 fake")


def test_ingest_dir_reports_empty_directory(tmp_path, monkeypatch):
    runner = CliRunner()
    result = runner.invoke(cli.main, ["ingest-dir", str(tmp_path)])
    assert result.exit_code == 0
    assert "No PDFs found" in result.output


def test_ingest_dir_ingests_every_pdf_and_skips_duplicates(tmp_path, monkeypatch):
    _touch_pdfs(tmp_path, ["a.pdf", "b.pdf", "c.pdf"])

    calls: list[str] = []

    def fake_ingest(path: Path) -> dict:
        calls.append(path.name)
        if path.name == "b.pdf":
            return {"id": "dup-id", "duplicate": True}
        return {"id": f"id-{path.name}", "duplicate": False}

    monkeypatch.setattr(cli.intake, "ingest", fake_ingest)
    process_calls: list[str] = []
    monkeypatch.setattr(cli, "_process", lambda document_id: process_calls.append(document_id))

    runner = CliRunner()
    result = runner.invoke(cli.main, ["ingest-dir", str(tmp_path)])

    assert result.exit_code == 0, result.output
    assert sorted(calls) == ["a.pdf", "b.pdf", "c.pdf"]
    assert "2 ingested, 1 duplicate(s), 0 failed, out of 3 PDF(s) found." in result.output
    # --process not passed: nothing should have been processed.
    assert process_calls == []


def test_ingest_dir_one_bad_pdf_does_not_abort_the_batch(tmp_path, monkeypatch):
    _touch_pdfs(tmp_path, ["good.pdf", "bad.pdf"])

    def fake_ingest(path: Path) -> dict:
        if path.name == "bad.pdf":
            raise ValueError("corrupt PDF")
        return {"id": "good-id", "duplicate": False}

    monkeypatch.setattr(cli.intake, "ingest", fake_ingest)
    monkeypatch.setattr(cli, "_process", lambda document_id: None)

    runner = CliRunner()
    result = runner.invoke(cli.main, ["ingest-dir", str(tmp_path)])

    assert result.exit_code == 0, result.output
    assert "FAILED to ingest bad.pdf" in result.output
    assert "1 ingested, 0 duplicate(s), 1 failed, out of 2 PDF(s) found." in result.output


def test_ingest_dir_with_process_flag_processes_each_ingested_document(tmp_path, monkeypatch):
    _touch_pdfs(tmp_path, ["a.pdf", "b.pdf"])

    monkeypatch.setattr(
        cli.intake,
        "ingest",
        lambda path: {"id": f"id-{path.name}", "duplicate": False},
    )
    process_calls: list[str] = []
    monkeypatch.setattr(cli, "_process", lambda document_id: process_calls.append(document_id))

    runner = CliRunner()
    result = runner.invoke(cli.main, ["ingest-dir", str(tmp_path), "--process"])

    assert result.exit_code == 0, result.output
    assert sorted(process_calls) == ["id-a.pdf", "id-b.pdf"]


def test_ingest_dir_process_flag_one_bad_document_does_not_abort_the_batch(tmp_path, monkeypatch):
    _touch_pdfs(tmp_path, ["a.pdf", "b.pdf"])

    monkeypatch.setattr(
        cli.intake,
        "ingest",
        lambda path: {"id": f"id-{path.name}", "duplicate": False},
    )

    def fake_process(document_id: str) -> None:
        if document_id == "id-a.pdf":
            raise RuntimeError("boom")

    monkeypatch.setattr(cli, "_process", fake_process)

    runner = CliRunner()
    result = runner.invoke(cli.main, ["ingest-dir", str(tmp_path), "--process"])

    assert result.exit_code == 0, result.output
    assert "FAILED to process id-a.pdf" in result.output

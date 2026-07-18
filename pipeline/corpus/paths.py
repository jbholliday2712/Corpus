"""Local on-disk locations. Gitignored — see repo .gitignore."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
INBOX_DIR = ROOT / "inbox"
STORE_DIR = ROOT / "store"
WORK_DIR = ROOT / "work"

# STATUS.md — Manual Ingestion Pipeline ("Corpus")

> Session handoff file. Read this fully before writing any code. Update the
> **Session Log** and **Current State** sections at the end of every session.

---

## 1. What this project is

A local-only ingestion app that runs on my laptop. I chuck fire & security
panel manuals (PDFs) into it, and it automatically extracts, chunks, embeds,
and upserts them into a Supabase database. That database is the corpus for a
future RAG chat app (built separately) that answers engineers' questions with
citations like "XFP engineering manual, p.34".

**Design principle: NOT PICKY.** No per-document tuning. The pipeline inspects
each PDF and routes it down the right extraction path automatically. Worst
case every page goes through the vision model — slower, still works.

**This app is never deployed.** It runs on the laptop only. No hosting
constraints apply here. The only shared artefact is the Supabase database,
which the future chat app will read from.

---

## 2. Stack (decided — do not relitigate)

| Layer | Choice | Notes |
|---|---|---|
| Pipeline runtime | Python 3.11+ CLI | Heavy lifting: extraction, chunking, embedding |
| Review UI | Minimal local Next.js app (App Router) | Talks to same Supabase; view/approve chunks |
| PDF text extraction | PyMuPDF (`pymupdf`) | Fast path for pages with a real text layer |
| Scan / table / diagram pages | Vision model via NVIDIA NIM API → structured markdown | Fallback path; render page to PNG first |
| Embeddings | NVIDIA NIM embedding endpoint (e.g. `nvidia/nv-embedqa-e5-v5`) | Same model MUST be used later at query time |
| LLM calls (metadata inference) | NVIDIA NIM (Llama 3.3 70B or similar) | One provider, one key, free tier |
| Database | Supabase Postgres + pgvector | Free tier. Source of truth = chunk TEXT, vectors are disposable |
| Cost target | £0 | Free tiers only. Rate-limit handling is mandatory, not optional |

**Provider abstraction rule:** all NIM calls (embed, vision, LLM) go through a
single `providers.py` module so the provider can be swapped by editing one
file. Never call the API inline from pipeline stages.

---

## 3. Database schema (Supabase)

```sql
-- Enable pgvector
create extension if not exists vector;

create table documents (
  id            uuid primary key default gen_random_uuid(),
  file_name     text not null,
  file_hash     text not null unique,        -- sha256; dedupe on re-drop
  manufacturer  text,                        -- e.g. 'CTec'
  panel_model   text,                        -- e.g. 'XFP'
  doc_type      text,                        -- 'engineering_manual' | 'install_manual' | 'datasheet' | 'user_manual' | 'other'
  revision      text,                        -- e.g. 'Rev 4' if inferable
  page_count    int,
  status        text not null default 'queued',
  -- queued | extracting | chunking | embedding | review | done | failed
  error_message text,                        -- populated when status = failed
  metadata_confirmed boolean default false,  -- true after I approve inferred metadata
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create table chunks (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references documents(id) on delete cascade,
  chunk_index   int not null,                -- order within document
  content       text not null,               -- SOURCE OF TRUTH (markdown)
  page_start    int,
  page_end      int,
  section       text,                        -- nearest heading
  extraction_path text,                      -- 'text' | 'vision'
  token_count   int,
  metadata      jsonb default '{}',
  embedding     vector(1024),                -- match NIM embed model dims; CHECK ACTUAL DIMS FIRST
  created_at    timestamptz default now()
);

create index on chunks using hnsw (embedding vector_cosine_ops);
create index on chunks using gin (to_tsvector('english', content));  -- hybrid search later
create index on chunks (document_id);
```

**IMPORTANT:** verify the embedding model's actual output dimensions before
creating the table. If it's not 1024, adjust `vector(N)`.

---

## 4. Pipeline stages

Each document moves through statuses. Every stage is resumable — a failed
document can be re-run from its last good stage without touching others.

### Stage 0 — Intake
- Watch folder: `./inbox/` (or `corpus ingest <file>` CLI command).
- Compute sha256. If hash exists in `documents`, skip with a "duplicate" log line.
- Insert row, status `queued`. Copy file to `./store/<hash>.pdf`.

### Stage 1 — Triage + Extraction (`queued → extracting`)
Per page:
1. Try PyMuPDF text extraction.
2. Heuristic: if extracted text < ~50 chars but the rendered page is not blank
   → mark page as `vision`. Also mark `vision` if page is table-dense
   (heuristic: high ratio of short lines / grid-like layout) — tune later,
   start simple.
3. `text` pages → keep PyMuPDF output as markdown-ish text.
4. `vision` pages → render to PNG at ~150 DPI → send to NIM vision model with
   prompt: "Transcribe this fire panel manual page to clean markdown.
   Preserve tables as markdown tables. Preserve numbered steps. Do not
   summarise or omit anything."
5. Write per-page markdown to `./work/<hash>/pages/NNN.md`.

Rate limiting: vision calls behind a retry-with-backoff wrapper
(handle 429s politely). Process pages sequentially; this runs unattended,
speed doesn't matter.

### Stage 2 — Metadata inference
- Send first ~3 pages' markdown to NIM LLM: "Identify manufacturer, panel
  model, document type (engineering_manual / install_manual / datasheet /
  user_manual / other), and revision if present. Respond ONLY as JSON:
  {manufacturer, panel_model, doc_type, revision}."
- Store on the document row. `metadata_confirmed = false` until I approve in
  the review UI (one-click confirm/edit).

### Stage 3 — Chunking (`extracting → chunking`)
- Concatenate page markdowns with page markers.
- Split on headings first, then pack sections into chunks of ~500–1000 tokens
  with ~100 token overlap.
- **Never split a markdown table or a numbered procedure across chunks.** If a
  table alone exceeds the max size, it becomes its own oversized chunk —
  oversized and intact beats split and useless.
- Record `page_start`/`page_end` per chunk (from page markers) and nearest
  heading as `section`.
- Insert chunk rows WITHOUT embeddings yet.

### Stage 4 — Embedding (`chunking → embedding`)
- Batch chunks (e.g. 16 at a time) to the NIM embedding endpoint.
- Retry with exponential backoff on 429/5xx. Persist after each batch so a
  crash resumes where it left off (embed only chunks where embedding is null).
- On completion → status `review`.

### Stage 5 — Review (`review → done`)
- In the review UI I eyeball the chunks (see §5). Approve → `done`.
- A `done` document is live for the future chat app. Documents not `done`
  should be excluded from retrieval by convention (chat app filters on it).

### Failure handling
- Any unhandled exception: set status `failed`, write `error_message`, move on
  to the next document. Never let one bad PDF kill the queue.
- CLI command `corpus retry <id>` re-runs from the failed stage.

---

## 5. Review UI (minimal Next.js app)

Pages:
1. **Queue view** — table of documents: name, inferred metadata, status,
   chunk count, error message if failed. Buttons: confirm metadata (with
   inline edit), retry, delete (cascades chunks).
2. **Document view** — chunks in order, rendered as markdown, showing page
   range, section, extraction path, token count per chunk. This is the
   inspection hatch: I check tables survived and sections make sense.
   Approve button sets `done`.

No auth (local only). Plain Tailwind, no design effort needed — function over
form here.

---

## 6. Repo structure

```
corpus/
├── STATUS.md              ← this file
├── pipeline/              ← Python
│   ├── pyproject.toml
│   ├── corpus/
│   │   ├── cli.py         ← entrypoints: ingest, watch, retry, status
│   │   ├── intake.py
│   │   ├── extract.py     ← triage + PyMuPDF + vision path
│   │   ├── metadata.py
│   │   ├── chunk.py
│   │   ├── embed.py
│   │   ├── providers.py   ← ALL NIM calls live here (embed/vision/llm)
│   │   ├── db.py          ← Supabase/Postgres access
│   │   └── config.py      ← reads .env
│   └── tests/
│       └── test_chunk.py  ← chunking is the one thing worth unit-testing
├── review-ui/             ← Next.js app (App Router)
├── inbox/                 ← drop PDFs here (gitignored)
├── store/                 ← content-addressed PDF copies (gitignored)
└── work/                  ← per-doc intermediate markdown (gitignored)
```

---

## 7. Environment (.env, gitignored)

```
NIM_API_KEY=
NIM_EMBED_MODEL=            # confirm exact model id + dims before schema
NIM_VISION_MODEL=
NIM_LLM_MODEL=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=       # service role; local trusted tooling only
DATABASE_URL=               # direct Postgres for pgvector ops if needed
```

---

## 8. Build order (milestones)

1. **M1 — Skeleton + DB.** Repo structure, .env, schema migration applied to
   Supabase, `providers.py` with a working embed call (verify dims), CLI stub.
2. **M2 — Happy path.** Digital PDF → extract (text path only) → chunk →
   embed → rows in Supabase. Test with one clean CTec XFP manual.
3. **M3 — Vision path + triage.** Scanned/table pages routed through NIM
   vision. Test with the ugliest manual I've got.
4. **M4 — Metadata inference + failure handling.** Status machine complete,
   retry command works, one bad PDF doesn't kill the queue.
5. **M5 — Review UI.** Queue view + document/chunk view + approve.
6. **M6 — Load the real corpus.** The 5 panels Ace actually works on, start
   with CTec XFP engineering + install manuals. Review every document.

Definition of done for the whole project: I can drop a manual in `inbox/`,
walk away, come back to a `review` status, spend 5 minutes eyeballing chunks,
click approve. Repeat for every manual we use at work.

---

## 9. Decisions already made (do not reopen in-session)

- RAG, not fine-tuning.
- NIM for embeddings + vision + LLM (free tier, one key). Swap = edit
  `providers.py` only.
- Chunk TEXT in Postgres is the source of truth; vectors are disposable and
  can be regenerated against any future embedding model.
- Same embedding model must be used at future query time — record the model
  id somewhere the chat app will read (suggest a `settings` table or just a
  constant documented here: __________ ).
- Manuals only for now. NO British Standards text in the corpus (BSI
  copyright). The future chat app may *reference* clause numbers, never
  reproduce standard text.
- This tool never generates certificates or compliance documents. Advisory
  output only, always cited. (Chat-app concern, but it shapes what metadata
  we keep: page numbers are mandatory on every chunk.)

---

## 10. Current state

- [x] M1 skeleton built: repo structure, `pipeline/` Python package,
      `providers.py` (embed/vision/llm via NIM), `db.py` (Supabase),
      `config.py` (.env loader), `cli.py` stub (check/ingest/watch/retry/status),
      `db/schema.sql` migration, `pipeline/tests/test_chunk.py`.
- [ ] **Not yet done — needs my real credentials, can't be done from this session:**
  - Fill in `pipeline/.env` (copy from `pipeline/.env.example`) with real
    NIM_API_KEY, NIM_EMBED_MODEL, SUPABASE_URL, SUPABASE_SERVICE_KEY, DATABASE_URL.
  - Apply `db/schema.sql` to the Supabase project.
  - Run `corpus check` (from `pipeline/`, after `pip install -e ".[dev]"`) to
    confirm Supabase connectivity and to print the real embedding dimension.
  - If the printed dims != 1024, edit `vector(1024)` in `db/schema.sql`
    before/after applying, then re-apply.
  - Once confirmed, record the model id via `db.set_setting("embedding_model", "<id>")`
    or manually in the `settings` table — this is what the future chat app reads.
- [ ] M2 not started: extract.py/chunk.py/embed.py are stubs that raise
      NotImplementedError. intake.py (hash + copy to store/ + insert row) is
      implemented and ready to use once Supabase is reachable.

## 11. Session log

| Date | Session summary | Next step |
|---|---|---|
| — | Project planned, STATUS.md created | Begin M1 |
| 2026-07-17 | M1 skeleton built on `main`: repo layout, `pipeline/` package (config, providers, db, cli stub, intake), `db/schema.sql`, chunk test scaffold. All committed directly to main per new workflow (no per-session branches). Verified `corpus check` degrades gracefully with no `.env`, `pytest` passes. | Fill in real `.env` values, apply schema to Supabase, run `corpus check` to confirm embedding dims, then start M2 (text-path happy path with one clean manual). |

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
  metadata      jsonb default '{}',          -- added in the cleaning-stage migration: non-fatal
                                              -- structured flags, e.g. {"cleaning_warning": {...}}
                                              -- when the >15%-stripped safety rail trips, or
                                              -- {"proceed_override": true} once a human clicks past it
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
  -- metadata->>'section_type': 'structural' (TOC/index/revision-history
  -- page) | 'runt' (<50 tokens, no same-section chunk to merge into) | unset
  -- for a normal chunk. metadata->>'retrieval_override' = 'true': a human
  -- explicitly re-included a structural/runt chunk via the Cleaning tab.
  -- See §9 — structural/runt chunks (without an override) MUST be excluded
  -- from similarity search.
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

### Stage 2.5 — Cleaning
NON-DESTRUCTIVE: raw per-page markdown in `./work/<hash>/pages/` (written by
Stage 1) is never modified. This stage reads it and writes
`./work/<hash>/cleaned/pages/` plus `./work/<hash>/furniture.json`; a failed
or over-aggressive clean never loses the original extraction.

1. **Furniture stripping** (deterministic, per document): normalise each
   line (collapse whitespace, digit runs → `#`) and count how many distinct
   pages it appears on. A line on ≥30% of pages (min 5 pages) is furniture
   (headers/footers/"Page X of Y"/running title) and is removed from the
   cleaned copy only. Exceptions, none of which are ever stripped regardless
   of repetition: lines inside a markdown table, lines >80 chars, and lines
   matching `/warning|caution|danger|note:/i` — a safety notice repeated on
   every page must never be silently dropped, even with the restore toggle
   available as a safety net (fire/security panel manuals specifically).
   `furniture.json` records every stripped line, its page count, and 2
   example pages.
2. **Structural page/chunk tagging** (not deletion): a page is TOC/index/
   revision-history if it has a heading matching
   `/^(contents|index|revision|document history)/i`, or if ≥50% of its lines
   look like TOC entries (dot leaders or a wide gap before a trailing page
   number). These pages still get chunked downstream (Stage 3), but their
   chunks get `metadata->>'section_type' = 'structural'` and — per §9 — MUST
   be excluded from similarity search.
3. **Runt handling** (applied after Stage 3 packs chunks): any chunk under
   50 tokens is merged into the previous chunk if they share the same
   `section` (cascades — several tiny same-section chunks in a row combine
   into one, and the merge tag clears if the combined size crosses 50
   tokens), otherwise tagged `metadata->>'section_type' = 'runt'`. Never
   deleted. A chunk already tagged `'structural'` is never a merge source or
   target, so unrelated content doesn't blur into a TOC-page chunk.
4. **Safety rail**: log total lines / lines stripped / % stripped per
   document. If >15% stripped, set `status = 'review'` with
   `documents.metadata.cleaning_warning` instead of proceeding to Stage 3/4
   automatically — that ratio means the heuristic likely misfired. A human
   can restore specific furniture lines (Cleaning tab, forces
   re-clean → re-chunk → re-embed via `corpus restore-furniture`) or click
   "proceed anyway" (`documents.metadata.proceed_override`, re-evaluated by
   `corpus retry` without needing to re-clean).

### Stage 3 — Chunking (`extracting → chunking`)
- Reads `./work/<hash>/cleaned/pages/` (not raw `pages/`).
- Split on headings first, then pack sections into chunks of ~500–1000 tokens
  with ~100 token overlap.
- **Never split a markdown table or a numbered procedure across chunks.** If a
  table alone exceeds the max size, it becomes its own oversized chunk —
  oversized and intact beats split and useless.
- Record `page_start`/`page_end` per chunk (from page markers) and nearest
  heading as `section`. A chunk's `metadata->>'section_type'` is
  `'structural'` if any source page was tagged structural in Stage 2.5.
- Apply Stage 2.5's runt handling (merge/tag chunks under 50 tokens) as a
  post-processing pass before insert.
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
- CLI command `corpus restore-furniture <id> <normalized_line>` is a
  targeted variant of retry for the Cleaning stage specifically: exempts one
  furniture line for this document going forward and forces a
  re-clean → re-chunk → re-embed (unlike `retry`, it always regenerates the
  cleaned pages and always replaces existing chunks, since the cleaned text
  itself changed).

---

## 5. Review UI (minimal Next.js app)

Pages:
1. **Queue view** — table of documents: name, inferred metadata, status
   (shown as a segmented `StageProgress` bar — queued/extract/clean&chunk/
   embed/review — not just a status word), chunk count, error message if
   failed. Buttons: confirm metadata (with inline edit), retry, delete
   (cascades chunks), reprocess (split button: default from cleaning,
   dropdown for from-chunking/from-embedding — warns if the document has
   manual chunk retrieval-include toggles that a clean/chunk reprocess
   would lose), hard reset (overflow menu, red, detailed confirm dialog).
   Polls a lightweight `/api/documents` endpoint every 3s for live
   status/error updates without a full page re-render. Every button that
   kicks off a background run (retry/reprocess/reset/approve/restore/
   upload) shows a spinner for the moment the request itself is in flight,
   not just a static label. Upload accepts one PDF or many at once
   (`<input multiple>`) with a real byte-level progress bar (XHR against
   `POST /api/documents/upload`, not a server action — see §10 for why);
   a single upload keeps the original redirect-to-that-document UX, a bulk
   upload redirects back to the queue with an ingested/duplicate/failed
   summary banner; one bad PDF in a batch doesn't abort the rest, matching
   `corpus watch`'s per-file handling. The CLI-side equivalent for a whole
   folder without opening a browser is `corpus ingest-dir <path>
   [--process]`.
2. **Document view** — chunks in order, rendered as markdown, showing page
   range, section, extraction path, token count per chunk. This is the
   inspection hatch: I check tables survived and sections make sense.
   Approve button sets `done`.
3. **Cleaning tab** (on the document view): the furniture lines removed for
   this document (from `furniture.json`) with a per-line "Restore" button
   (triggers `corpus restore-furniture`); every structural/runt chunk,
   greyed out, with an "Include in retrieval" toggle (sets/clears
   `chunks.metadata.retrieval_override`); if the >15%-stripped safety rail
   tripped, a warning plus a "Proceed anyway" button
   (`documents.metadata.proceed_override`).

No auth (local only). Plain Tailwind, no design effort needed — function over
form here. (In practice the queue/document views grew a fair bit past
"no design effort" once real use surfaced that bare tables weren't
user-friendly — see §10/§11 for what actually shipped: upload, a chunk
similarity graph, search, automatic flagging, and now the Cleaning tab.)

---

## 6. Repo structure

```
corpus/
├── STATUS.md              ← this file
├── supabase/
│   ├── config.toml        ← links this repo to the Supabase project (GitHub integration)
│   └── migrations/        ← schema migrations, auto-applied on push to main
├── pipeline/              ← Python
│   ├── pyproject.toml
│   ├── corpus/
│   │   ├── cli.py         ← entrypoints: ingest, ingest-dir, watch, retry,
│   │   │                     restore-furniture, reprocess, reset,
│   │   │                     embed-query, status
│   │   ├── intake.py
│   │   ├── extract.py     ← triage + PyMuPDF + vision path
│   │   ├── metadata.py
│   │   ├── clean.py       ← furniture stripping, structural tagging,
│   │   │                     safety rail (Stage 2.5)
│   │   ├── chunk.py       ← packing + runt handling
│   │   ├── embed.py
│   │   ├── reprocess.py   ← reprocess_document/reset_hard — importable
│   │   │                     logic behind `corpus reprocess`/`reset`, also
│   │   │                     called directly by review-ui's API routes
│   │   ├── providers.py   ← ALL NIM calls live here (embed/vision/llm)
│   │   ├── db.py          ← Supabase/Postgres access
│   │   └── config.py      ← reads .env
│   └── tests/
│       ├── test_chunk.py
│       ├── test_clean.py  ← the furniture detector is the other thing
│       │                     worth unit-testing
│       ├── test_reprocess.py ← monkeypatched db/clean/chunk/embed, asserts
│       │                        call order + idempotency per from-stage
│       └── test_cli.py    ← CliRunner argv/orchestration tests
│                              (ingest-dir batch/duplicate/failure handling)
├── review-ui/             ← Next.js app (App Router)
├── inbox/                 ← drop PDFs here (gitignored)
├── store/                 ← content-addressed PDF copies (gitignored)
└── work/<hash>/            ← per-doc intermediate markdown (gitignored)
    ├── pages/NNN.md            ← raw extraction (Stage 1), never modified
    ├── cleaned/pages/NNN.md    ← Stage 2.5 output, what Stage 3 reads
    ├── furniture.json          ← what Stage 2.5 stripped + why
    └── furniture_overrides.json ← lines a human restored via the Cleaning tab
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
- **Structural and runt chunks must be excluded from similarity search.**
  Chunks tagged `metadata->>'section_type' = 'structural'` (TOC/index/
  revision-history pages) or `'runt'` (<50 tokens, no same-section chunk to
  merge into — see §4 Stage 2.5) are chunked and embedded like any other
  chunk, but the future chat app's retrieval query MUST filter them out
  unless `metadata->>'retrieval_override' = 'true'` (a human explicitly
  re-included one via the review UI's Cleaning tab). review-ui's own
  chunk-graph/search features (`chunk_similarity_edges`, `search_chunks` —
  see supabase/migrations) already apply this same filter, since they're an
  explicit preview of that future retrieval behaviour — keep any future
  retrieval-adjacent code consistent with it.
- **Safety-critical repeated text is never auto-stripped as furniture.**
  Lines matching `/warning|caution|danger|note:/i` are exempt from the
  furniture heuristic regardless of how many pages they repeat on — decided
  when building the cleaning stage: a page footer being wrongly stripped is
  a UX papercut with a restore toggle as the safety net, but a real safety
  notice silently missing from a fire/security panel manual is a different
  category of risk, and shouldn't rely on a human noticing it's gone from
  `furniture.json`.

---

## 10. Current state

- [x] M1 skeleton built: repo structure, `pipeline/` Python package,
      `providers.py` (embed/vision/llm via NIM), `db.py` (Supabase),
      `config.py` (.env loader), `cli.py` stub (check/ingest/watch/retry/status),
      `pipeline/tests/test_chunk.py`.
- [x] Supabase GitHub integration set up: `supabase/config.toml` +
      `supabase/migrations/20260718000000_initial_schema.sql` (schema moved
      out of `db/schema.sql`, which no longer exists).
  - **Unconfirmed:** pushed this migration to `main` and waited ~3 min;
    it never auto-applied via the integration. Applied it manually instead
    (direct `psycopg2` connection using `DATABASE_URL`). Before relying on
    "push = auto-deployed schema", check Project Settings → Integrations →
    GitHub in the Supabase dashboard to confirm it's actually linked to this
    repo/branch — it may need a manual link/approval step. Future migrations
    should go in `supabase/migrations/` either way; fall back to the manual
    `psycopg2`/`DATABASE_URL` apply if the integration doesn't pick them up.
- [x] `pipeline/.env` filled in with real credentials and confirmed working
      via `corpus check`: Supabase reachable, `documents`/`chunks`/`settings`
      tables exist, NIM embed model `nvidia/nv-embedqa-e5-v5` confirmed at
      1024 dims (matches `vector(1024)` in the migration — no schema change
      needed).
  - Note: `SUPABASE_SERVICE_KEY` must be the **secret** key (`sb_secret_...`
    or legacy `service_role` JWT), not the `sb_publishable_...` key — the
    publishable/anon key was pasted in there initially and caused a
    misleading "table not found in schema cache" error from PostgREST.
  - Note: local Norton Antivirus does SSL/TLS interception on outbound
    HTTPS, which broke Python's cert verification for the Supabase and NIM
    hosts. Fixed by appending Norton's local root CA (pulled from
    `Cert:\LocalMachine\Root`) to the `certifi` bundle Python uses. This is
    a machine-local fix, not something in the repo — if this env is ever
    reset or another machine hits the same error, redo it there too.
- [ ] **Still needs my input:**
  - `NIM_VISION_MODEL` / `NIM_LLM_MODEL` are blank — not required for M1,
    but needed before M3 (vision path) / M4 (metadata inference).
  - Once confirmed, record the model id via `db.set_setting("embedding_model", "<id>")`
    or manually in the `settings` table — this is what the future chat app reads.
- [x] M2 code written: `extract.py` (text-only PyMuPDF extraction, resumable
      per page — skips pages already written to `work/<hash>/pages/*.md`),
      `chunk.py` (real chunker: `chunk_pages()` is a pure, DB-free function —
      splits on blank-line paragraphs, detects markdown tables and numbered
      procedures and keeps them atomic/never split across a chunk boundary,
      packs to ~500–1000 tokens with ~100 token overlap via `estimate_tokens`
      (chars/4 approximation), tracks nearest heading as `section`;
      `chunk_document()` is the thin DB/file wrapper around it), `embed.py`
      (batches of 16 to the NIM embed endpoint, re-queries null-embedding
      chunks each loop so a crash resumes cleanly). Added `corpus process
      <document_id>` CLI command and wired `watch` to auto-run the full
      pipeline after ingest (one bad PDF is caught, marked `failed`, and the
      loop continues — the general failure-handling principle from §4,
      applied now rather than deferred to M4).
  - Added `pipeline/corpus/paths.py` (shared `INBOX_DIR`/`STORE_DIR`/`WORK_DIR`
    constants, previously duplicated) and `db.get_document(id)`.
  - Unit-tested `chunk_pages()` directly (7 tests: single chunk, heading
    detection, multi-page splitting, table stays intact, numbered procedure
    stays intact, overlap carries content forward, token estimator sanity) —
    all passing.
  - Smoke-tested `extract_document`'s PyMuPDF loop against a synthetic
    in-memory PDF (no DB involved) — text comes out per page as expected.
- [x] **M2 verified end-to-end against real Supabase/NIM** (on the laptop,
      where `.env` lives): `git pull`, `pip install -e ".[dev]"`, `pytest`
      → 7 passed. Ran the full pipeline on a synthetic 3-page test PDF
      (heading + paragraph + markdown table + numbered procedure, built
      with PyMuPDF, not a real manual) via `corpus ingest` +
      `corpus process <id>`:
  - `extract` → 3 pages written to `work/<hash>/pages/*.md`.
  - `chunk` → 1 chunk (content was small enough to fit under 1000 tokens):
    table rows and the numbered procedure both came through intact in
    `content`, nothing split.
  - `embed` → NIM embed call succeeded; verified the stored `chunks.embedding`
    is genuinely 1024 floats (PostgREST returns pgvector columns as a
    string, e.g. `"[0.1,0.2,...]"`, not a JSON array — `len()` on it counts
    characters, not dims; parse/count commas to check the real length).
  - `corpus status` showed `review` for the document, as expected.
  - Deleted the synthetic document afterward (`documents` row cascades to
    `chunks`) plus its `store/`/`work/` files — it was a mechanics smoke
    test, not real corpus content.
- [ ] **Still needed for a *real* M2 sign-off:** run it again with an actual
      clean digital CTec XFP manual (or whatever's on hand) via `corpus
      watch` or `corpus ingest` + `corpus process`, and eyeball the resulting
      chunks for genuine content quality (section headings, real tables,
      real procedures) — the synthetic test only proves the mechanics work,
      not that chunking judgment is good on a real document.
- [x] M3 code written (triage + vision path), same sandbox/no-`.env`
      constraint as the M2 build — unit-tested and smoke-tested, not yet run
      against real NIM vision:
  - `extract.py`: `needs_vision(page, text)` triages each page — vision if
    the text layer is under ~50 chars AND the rendered page isn't actually
    blank (checked by rendering at 0.3x to grayscale and measuring the
    non-white pixel fraction — catches scanned pages while leaving truly
    blank pages on the cheap text path), OR if the extracted text looks
    table-dense (≥65% of lines ≤20 chars, heuristic per STATUS.md, "tune
    later"). Vision pages render at ~150 DPI and go through
    `NIMClient.vision_transcribe` with the exact prompt from §4. The NIM
    client is constructed lazily — a pure-text document still needs no
    vision credentials at all.
  - Page files now carry a one-line marker (`<!-- path: text|vision -->`)
    so `chunk.py` knows which pages were vision-derived; `write_page`/
    `read_page` in `extract.py` handle it (old M2-era page files without the
    marker default to `text`, so nothing needed re-extracting).
  - `chunk.py`: blocks now carry `extraction_path`; a chunk is marked
    `vision` if *any* contributing page was vision-derived (conservative —
    flags it for extra scrutiny in review), else `text`.
  - New tests: `tests/test_extract.py` (7 — vision triage on a
    synthetic scanned-looking page vs. a normal text page vs. a truly blank
    page, table-density detection, page-marker round-trip) and 3 more in
    `test_chunk.py` for extraction_path propagation. 17/17 passing overall.
    Manually traced a synthetic mixed text+scanned 2-page PDF through
    triage → page files → chunking (NIM call itself simulated, not made —
    no credentials here) and confirmed the vision page was correctly routed
    and the resulting chunk correctly flagged `vision`.
- [x] **M3 mechanics verified end-to-end against real Supabase/NIM.** Pulled,
      reinstalled, `pytest` → 17/17. Set `NIM_VISION_MODEL=meta/llama-3.2-11b-vision-instruct`
      (was blank; picked as a small/fast free-tier default — untested against
      alternatives). Sanity-checked the model id with a direct
      `vision_transcribe` call before running the pipeline (confirmed it
      actually reads text out of an image). Built a synthetic 3-page test PDF
      with one prose page, one no-text "scanned-looking" page (drawn shapes,
      no real content), and one page with real extractable but grid-like
      table text — then ran it through `ingest` + `process`.
  - Triage routed correctly: page 1 stayed on the `text` path; page 2 (no
    text layer) and page 3 (table-dense per the heuristic, even though
    PyMuPDF *could* extract its text) both correctly went to vision.
  - On page 3, the vision model actually reconstructed the zone/address grid
    as a proper markdown table — genuinely better than PyMuPDF's raw
    flattening of dense grid text. That part is a real win.
  - **Found a real problem, not a synthetic-test artifact:** on page 3 the
    vision model fell into a degenerate repetition loop — it re-emitted the
    identical 20-row table **~30 times in a row** until hitting
    `max_tokens=4096` in `providers.py::vision_transcribe`. `chunk.py` then
    did exactly what it's designed to do with that input (correctly kept
    each table instance atomic, packed them into chunks at the token limit)
    — the chunker isn't the bug. The bug is that nothing between the vision
    call and the DB insert detects or guards against a model repeating
    itself, so this would silently write many near-duplicate chunks (wasted
    embedding calls + budget, and duplicate/misleading results at retrieval
    time) for any real page whose content is regular/grid-like enough to
    trigger it — which is exactly the "Zone Configuration Table" style
    content this pipeline exists to handle (see §3's own example table).
  - On page 2 (the content-free drawn-shapes page), the vision model didn't
    refuse or return anything obviously wrong — it hallucinated plausible-
    sounding but fabricated "Fire Panel Manual" boilerplate. Expected for a
    genuinely blank/content-free synthetic page and not directly testable
    with real content, but worth remembering: there's currently no
    hallucination check either, so a low-content real page (e.g. a mostly-
    white page with a small logo) could produce confident-sounding nonsense
    that goes straight into the corpus.
  - Cleaned up the test document (Supabase row + `store/`/`work/` files)
    afterward. The hallucination-on-blank-page risk noted above is a
    separate, still-open concern — not addressed here, this task was
    specifically the repetition-loop fix.
- [x] **Repetition-loop guard implemented** — the decision above is resolved:
  `providers.py`: `_detect_repetition(text)` added, called right before
      `vision_transcribe` returns — catches a vision model looping on the
      same paragraph (or a 2-3 paragraph cycle) 3+ times in a row (e.g. the
      same table pasted 30 times) and truncates to one copy, before it ever
      reaches `chunk.py` or costs an embedding call. Deliberately cheaper
      and safer than just lowering `max_tokens`: a smaller cap only shrinks
      the blast radius (3-4 copies instead of 30), it doesn't fix it, and a
      hard cutoff can slice a genuinely long legitimate table in half.
  - "Near-exact" match is whitespace-normalization only, not fuzzy
    similarity — tried a `difflib.SequenceMatcher` ratio first and caught a
    real bug with it: sequential-but-distinct table rows (e.g. `Zone 0 /
    Addr 000` vs `Zone 1 / Addr 001`) differ by only 1-2 characters out of
    ~30, so a 0.9 similarity threshold flagged them as "the same" repeating
    row and truncated a legitimate 40-row table down to one row. Dropped
    the fuzzy fallback; whitespace normalization alone still catches actual
    repeat loops (which re-emit byte-identical or whitespace-jittered text)
    without conflating them with rows that are merely similar-looking.
  - `tests/test_providers.py` (10 tests): single-paragraph and 2-3
    paragraph cycles truncated at 3+ reps, exactly-2 reps left alone (with
    and without a preceding paragraph), whitespace-only near-exact variants
    caught, sequentially-different rows explicitly *not* flagged (the
    regression test for the false positive above), a long non-repeating
    table left untouched, short output left untouched. 27/27 passing
    overall (pipeline-wide).
- [x] **Repetition-loop fix verified.** Pulled, reinstalled, `pytest` → 27/27.
  Re-ran the same synthetic mixed-content PDF that originally triggered the
  loop, through the real pipeline again. This time the live vision call
  didn't reproduce the exact same runaway loop (these hosted models aren't
  perfectly deterministic even at `temperature=0` — this run instead echoed
  the table twice inside a hallucinated narrative, only 2 reps, which
  `_detect_repetition` correctly leaves alone per its "more than twice"
  rule). Since a live call can't be relied on to reproduce a specific
  failure on demand, verified the fix directly instead: fed the *exact*
  originally-captured 30x-repeated table text (10,738 chars) straight into
  `_detect_repetition` — truncated correctly to one clean copy (356 chars).
  Confirms the fix actually resolves the bug that was found, independent of
  whether any given live call happens to misbehave the same way twice.
  - Separately reconfirmed the hallucination-on-low-content-page risk noted
    last session is real and not hypothetical: this run's page 2 (still a
    content-free synthetic page) again produced a fully fabricated generic
    "Fire Panel Manual" narrative with invented steps. This is a distinct,
    still-open issue from the repetition loop (which is now fixed) — no
    guard exists for it yet.
  - Cleaned up the test document (Supabase row + `store/`/`work/` files)
    afterward.
- [x] **Tested against a real manual** (Pyronix Enforcer V11 installation
      guide, 16 pages, not synthetic) via `corpus ingest` + `corpus process`.
      10 pages stayed on the text path, 6 went to vision (pages 3, 6, 10, 12,
      14 via the table-dense heuristic — all have substantial real
      extractable text, e.g. wiring/zone tables PyMuPDF flattens badly; page
      16 via the thin-text-and-not-blank heuristic). Content on the
      legitimate table-dense pages checked out — e.g. page 12's vision
      transcription of the external-siren wiring instructions correctly
      preserved real terminology (EOL values, resistor specs, SCB mode,
      tamper terminals) matching the actual diagram. No repetition-loop
      firing on real content.
  - **Confirmed the hallucination risk for real, on real content, not just
    synthetically:** page 16 is the back cover — a solid red design block,
    the Pyronix logo, and UKCA/CE marks, nothing else (rendered it to a PNG
    to check). PyMuPDF got zero text from it, so it went to vision, which
    fabricated an entire fake manual: invented model number "FP-1000", a
    fake specs table, fake warranty terms, a fake support phone number, and
    even the wrong document title ("Pyronix Fire Panel Manual" instead of
    the real "Enforcer V11"). That was sitting in `chunks` as real corpus
    content, indistinguishable from genuine transcription.
  - **First fix attempt (prompt-only) failed.** Tried instructing the model
    in `VISION_PROMPT` to respond with a fixed sentinel (`NO_CONTENT`) when
    a page has nothing to transcribe, and added `_vision_content_or_empty`
    to turn that into empty page content. Re-tested directly against the
    real page 16 image: the model ignored the instruction entirely and
    fabricated a *different* fake manual (fake version "1.0", fake date,
    fake table of contents) instead of returning the sentinel. This 11B
    vision model can't be trusted to self-report "nothing here" — prompt
    engineering alone doesn't solve it. (`_vision_content_or_empty` and the
    sentinel stayed in — harmless, and would still help if a future/larger
    model *does* cooperate — but they aren't what actually fixes this.)
  - **Real fix: `_is_flat_graphic(page)` in `extract.py`**, gating the
    vision call itself rather than trusting the model's output. Renders the
    page to grayscale at low-res, divides it into a 10x10 grid, and checks
    what fraction of grid *rows* contain at least one high-variance
    ("textured") cell. Real text/diagrams vary across most of the page's
    vertical extent (many rows show texture); a flat design page's solid
    color blocks only produce texture in the couple of rows where a block's
    top/bottom edge falls, with uniform (zero-variance) rows everywhere
    else. `needs_vision` now treats a flat-graphic page like a blank one —
    skip vision, write empty content, contributes no chunk. First version
    used overall textured-*cell* fraction (not row fraction) and wrongly
    still routed the real cover to vision, because a shape's edges alone
    can light up a large fraction of individual cells without the page
    having real content; switching to row-coverage fixed it.
  - Validated directly against the real PDF (not just synthetic fixtures)
    both before and after each iteration — this is what caught the first
    version's failure and confirmed the row-coverage version actually
    works: `_is_flat_graphic(real page 16)` → `True`, `needs_vision` → the
    other 15 real pages' routing is completely unchanged.
  - Unit tests needed a real fixture too: a single centered box (the
    original synthetic fixture) turned out to be a poor proxy — it has
    vertical edges away from the page margins, which arguably *is*
    reasonable to send to vision (could be a real boxed diagram/photo).
    The actual failure shape is edge-to-edge color bands with no vertical
    edges, matching the real cover. Fixture rebuilt to draw full-width
    bands instead; a separate `draw_scribble` fixture (many small
    scattered line segments) stands in for genuinely textured scanned
    content. 6 new tests, 33/33 passing overall.
  - Re-ran the real Enforcer V11 document end-to-end with the fix: page 16
    now writes empty content (no vision call made at all — saves the API
    call too, not just the corpus quality), final chunk count correctly
    dropped from 9 to 8, no fabricated back-cover chunk. Confirmed by
    reading `chunks` back from Supabase after the re-run.
  - Accidentally deleted the real ingested document (Supabase rows +
    local files) after verification, on autopilot from cleaning up the
    earlier *synthetic* test PDFs — this one was real content, not a
    disposable test. Caught it and asked; you said it was fine to leave
    deleted (it was only being used as an M3 test in this session, not yet
    building the real corpus). Source PDF is untouched in Downloads, so
    it's re-ingestable any time.
- [ ] **Still open, not addressed:** hallucination risk on low-content
      pages that _is_flat_graphic doesn't catch — e.g. a page with a
      little real text mixed with mostly white space, or content-bearing
      images that aren't flat (a real photo/diagram with sparse content).
      The current guard only catches the specific "flat color blocks"
      shape confirmed on this manual's cover; it's not a general
      hallucination detector. Revisit if another manual surfaces a
      different flavor of fabricated content.
- [x] **M3 is now genuinely done** on both mechanics and the one real
      quality issue found.
- [x] M4 code written (same sandbox/no-`.env` constraint as every build
      session — logic verified with monkeypatched DB/NIM, not yet run
      against real Supabase/NIM):
  - `metadata.py`: `infer_metadata(document_id)` sends the first 3 extracted
    pages to `NIMClient.llm_complete` with the exact prompt from STATUS.md
    §4 Stage 2, asking for JSON `{manufacturer, panel_model, doc_type,
    revision}`. `_parse_metadata_response` (pure, unit-tested) tolerates a
    markdown code fence and prose around the JSON object, and coerces an
    out-of-enum `doc_type` to `'other'` rather than raising — NOT PICKY, and
    a human confirms metadata in the review UI anyway (`metadata_confirmed`
    stays `false`, unchanged from the M1 schema default). Resumable: if the
    document row already has a `doc_type`, returns the stored values instead
    of re-spending an LLM call.
  - Wired into `_process` in `cli.py` (extract → **metadata** → chunk →
    embed) as **best-effort** — a metadata failure (bad/missing
    `NIM_LLM_MODEL`, malformed LLM response) is logged and skipped, not
    fatal to the document. Rationale: metadata is a human-reviewed
    enrichment layered on top of the core content pipeline, not a
    prerequisite for it — a manual should still get its chunks/embeddings
    into the corpus even if metadata inference has a bad day.
  - **Fixed a real resumability gap while building `corpus retry`:**
    `chunk_document` previously re-inserted a full fresh chunk set on every
    call with no check for existing rows. That's fine standalone, but it
    would have broken `embed_document`'s own resumability on retry — if
    chunking had already succeeded and embedding was partway through when a
    later batch failed, retrying the pipeline would re-chunk (deleting nothing
    but inserting *duplicate* rows) or at minimum orphan the
    already-embedded rows' meaning from the fresh set. Fixed: `chunk_document`
    now checks `db.count_chunks(document_id)` first and skips straight to
    `status=chunking` if chunks already exist, exactly mirroring how
    `extract` skips already-written pages and `embed` skips
    already-embedded chunks. `db.count_chunks` added.
  - `corpus retry <document_id>` now actually works — it's the same
    `_process` (extract → metadata → chunk → embed) as `process`/`watch`,
    which is the point: every stage is independently resumable (checks its
    own DB/filesystem state), so re-running the whole pipeline on a
    previously-`failed` document is safe and cheap — it only redoes the
    stage(s) that didn't finish, never repeats NIM calls (vision, LLM,
    embed) for work that already succeeded. `_process` also now clears
    `error_message` on a fully successful run so stale error text doesn't
    linger after a fix.
  - `watch`'s per-document try/except (one bad PDF doesn't kill the loop)
    was already in place from M2/M3 — confirmed still intact, no changes
    needed there for M4's "failure handling" requirement.
  - New tests: `tests/test_metadata.py` (8 tests — plain JSON, code-fence-
    wrapped JSON, prose around the JSON, unrecognized/missing `doc_type`
    coerced to `'other'`, missing/empty fields become `None`, unparseable
    response raises). 41/41 passing pipeline-wide.
  - Manually verified (monkeypatched `corpus.db`/`corpus.providers`, no real
    network) that: (1) `infer_metadata` calls the LLM exactly once across
    two calls when the second call finds `doc_type` already set, and (2)
    `chunk_document` does not call `insert_chunks` again when chunks already
    exist for the document, returning the existing count instead.
- [x] **M4 verified end-to-end against real Supabase/NIM.** Pulled,
      reinstalled, `pytest` → 41/41. Set
      `NIM_LLM_MODEL=meta/llama-3.3-70b-instruct` (was blank) and
      sanity-checked it with a direct call before running the pipeline.
  - **Metadata inference**, re-run on the real Enforcer V11 manual:
    `panel_model` "ENFORCER V11", `doc_type` "install_manual", `revision`
    "03" all came back clean and correct. `manufacturer` did not — it came
    back as `"Pyronix (implied, not explicitly stated but Enforcer V11 is a
    known model of Pyronix)"`, the model's reasoning baked straight into the
    field value, despite the prompt saying "Respond ONLY as JSON." Reran on
    a second (synthetic) document to check it wasn't a one-off: same
    pattern, this time on `manufacturer` *and* `revision` (`"Not explicitly
    stated, but likely Apollo or a similar fire alarm systems manufacturer
    given the context of the XFP panel"` / `"Not present in the provided
    text"` instead of `null`). Confirmed pattern, not a fluke.
    `_parse_metadata_response` only validates/coerces `doc_type`;
    manufacturer/panel_model/revision are stored as whatever string comes
    back, unvalidated. Lower severity than the M3 vision hallucination —
    it's not inventing a false fact, just failing to follow the
    ONLY-the-value instruction — and `metadata_confirmed` stays `false`
    specifically so a human catches this in review before it's trusted. Not
    fixed; flagging for a decision (see below).
  - **`corpus retry`**, tested against a genuine failure, not just
    idempotency: forced a real embed-stage failure (temporary bogus
    `NIM_EMBED_MODEL` env override, not touching `.env`) on a synthetic
    document. Confirmed `status` → `failed` with the real HTTP error
    captured in `error_message`, and the chunk existed with a `null`
    embedding. Restored the correct model and ran `corpus retry <id>`: it
    skipped re-extracting (pages already on disk), skipped re-calling the
    LLM (`doc_type` already set), skipped re-inserting the chunk (already
    existed), and correctly only redid the embed step that had actually
    failed. Final state: `status=review`, `error_message` cleared to
    `null`, still exactly 1 chunk (no duplication). Also re-ran `corpus
    retry` on the *already-successful* Enforcer V11 document as a pure
    idempotency check — confirmed 0 wasted work across every stage (0
    chunks re-embedded, chunk count unchanged, no duplicate LLM/vision
    calls). Both the crash-recovery path and the idempotency path work as
    designed.
  - Cleaned up both test documents (Supabase rows + `store/`/`work/` files)
    afterward — source PDFs untouched, both re-ingestable later.
- [ ] **Decision needed:** how to stop the LLM from writing explanatory
      prose into `manufacturer`/`revision` instead of a clean value or
      `null`. Options: tighten the prompt further (e.g. explicit "the value
      must be a short string or null, never an explanation — if unsure,
      use null" — though M3's experience with prompt-only fixes for the
      vision model failing outright is a reason for skepticism this alone
      will hold up), or add post-processing validation (e.g. reject/null
      out a field if it's implausibly long for what it's supposed to hold,
      similar in spirit to how `doc_type` is already coerced against an
      enum). Not urgent to block on — `metadata_confirmed=false` means
      review UI already catches it — but worth deciding before M5 if the
      review UI is expected to show these fields as clean, editable text.
  5. Once that looks right, M4 is done.
- [x] **M4 is done.**
- [x] M5 built: `review-ui/` — minimal Next.js 16 App Router app, TypeScript,
      Tailwind v4, no auth (local-only trusted tool per STATUS.md §1). Two
      pages per §5:
  - **Queue view** (`app/page.tsx`, `/`): table of all documents — file
    name/page count, an inline-editable metadata form (manufacturer/panel
    model/doc_type-as-dropdown/revision, "Confirm"/"Update" button —
    deliberately plain editable text inputs, not read-only display, because
    of the M4 finding that the LLM sometimes writes explanatory prose into
    `manufacturer`/`revision` instead of a clean value; this is where a
    human fixes that before confirming), status badge, chunk count, error
    message, and Retry (only shown when `status=failed`) / Delete buttons
    (Delete has a JS confirm() dialog — the one Client Component in the app,
    everything else is server-rendered).
  - **Document view** (`app/documents/[id]/page.tsx`): chunks in
    `chunk_index` order, each showing page range, section, extraction path
    (vision-derived chunks visually flagged), token count, and the full
    markdown content preformatted — the actual "did tables/procedures
    survive intact, does this read like the real manual" inspection hatch.
    "Approve → done" button when `status=review`.
  - **Confirm/Delete/Approve** are direct Supabase mutations via Server
    Actions (`app/actions.ts`) using the service role key server-side only
    (`lib/supabase.ts`), never exposed to the browser. Delete relies on the
    existing `ON DELETE CASCADE` on `chunks.document_id` from the M1 schema.
  - **Retry** is different: the actual retry logic lives in the Python CLI
    (`corpus retry`, built in M4, resumable per stage), and this Next.js app
    has no reason to reimplement it — so the Retry button's server action
    shells out to `python -m corpus.cli retry <id>` as a detached background
    process (`CORPUS_PYTHON` / `CORPUS_PIPELINE_DIR` env vars point at the
    pipeline's venv python and directory) and redirects back to the queue
    with a "running in the background, reload in a bit" banner — a retry
    can take minutes on a vision-heavy document, so nothing awaits it
    in-request.
  - `review-ui/.env.local.example` documents all four required env vars.
  - **Real build issue found and fixed:** `npm install`'s resolved "latest"
    `typescript` was `7.0.2` — as of this session's date that's evidently a
    new major line (likely the native/Go compiler rewrite), and it crashed
    Next's internal type-checking step with an opaque
    `The "id" argument must be of type string. Received undefined` error
    with no useful stack trace. Root-caused by diagnostically disabling the
    TypeScript build step (`ignoreBuildErrors`) to confirm the crash was in
    that step, not route generation, then pinning `typescript` to `^5.9.3`
    (the line Next 16.2.10 actually expects) — fixed cleanly, no
    workaround/ignoreBuildErrors left in the shipped `next.config.ts`.
  - Also noted: `next build --webpack` fails to resolve the `@/*` path
    alias entirely (`Module not found`) even with `baseUrl` set in
    `tsconfig.json`, while the default Turbopack build resolves it fine.
    Not investigated further since Turbopack is Next 16's default and the
    actual build/dev path this app uses — flagging in case a future
    Next.js upgrade needs the webpack fallback for some reason.
  - **Verified in this sandbox** (no real Supabase here, same constraint as
    every build session): `npm install`, `npx tsc --noEmit` clean, `next
    build` succeeds (both `/` and `/documents/[id]` correctly marked
    dynamic/server-rendered, not statically prerendered — they need fresh
    DB data every load), and `next dev` actually boots and serves both
    routes — confirmed each returns a clean HTTP 500 with the exact
    `SUPABASE_URL / SUPABASE_SERVICE_KEY are not set` error message (from
    `lib/supabase.ts`) rather than crashing, i.e. the app fails predictably
    without credentials instead of breaking in some opaque way.
- [x] **Post-M5 feedback addressed** — you tried the review UI and flagged
      three gaps: no way to add a document from the UI, no visual feedback
      on how documents relate to each other, and general un-friendliness
      (no live progress, bare-bones design, hard to navigate). All three
      built:
  - **Upload (queue view):** `corpus ingest` gets a `--json` flag
    (`{id, duplicate, file_name}`) for programmatic use. A new
    `uploadDocument` server action stages the uploaded file to a temp path,
    awaits `corpus ingest --json` (fast, no NIM calls) for the document id,
    then fires `corpus process <id>` as a detached background process —
    same fire-and-forget pattern as Retry, since extract/metadata/chunk/
    embed can take minutes. Redirects to the new document's page with an
    "uploaded, updates automatically" or "already ingested" banner.
    `next.config.ts`'s Server Actions body limit raised to 50mb (manuals
    routinely exceed the 1mb default).
  - **Chunk-level similarity graph** (`/graph`, new nav link): nodes are
    individual chunks (not documents — you picked chunk-level explicitly),
    colored by source document, edges are embedding cosine similarity
    &ge;0.78 (top 5 neighbours per chunk). New migration
    `chunk_similarity_edges.sql` adds a Postgres function that walks the
    existing HNSW index per-chunk via a lateral join rather than a full
    pairwise scan, so it stays cheap as the corpus grows — call it via
    Supabase RPC. Rendered with `react-force-graph-2d` (canvas-based,
    dynamically imported client-side only). Clicking a node navigates to
    `/documents/<id>#chunk-<chunkId>`; the document page gives every chunk
    that id and `globals.css` adds a plain CSS `:target` outline rule, so
    the linked chunk is highlighted with zero extra JS. Will look sparse
    with only a document or two loaded — expected to get more interesting
    once M6 loads the real 5-panel corpus.
  - **UX pass:** persistent header/nav (`app/layout.tsx`) across Queue and
    Graph; card-based layout instead of a bare table (rounded borders,
    shadows, consistent spacing); `AutoRefresh` client component
    (`router.refresh()` every 4s) rendered only on pages with a document in
    an active status (`queued`/`extracting`/`chunking`/`embedding`), so
    status changes show up without a manual reload — banners updated from
    "reload this page" to "updates automatically" accordingly; a small
    pulsing-dot indicator on `StatusBadge` for active statuses as an
    at-a-glance "something's happening" cue.
  - Real dependency check: `react-force-graph-2d` added cleanly, `npm
    audit` shows the same 2 pre-existing moderate vulnerabilities as before
    (both inside Next.js's own bundled postcss, unrelated to this) — no new
    ones introduced.
  - **Verified in this sandbox** (still no real Supabase/`.env.local`
    here): `tsc --noEmit` clean, `next build` succeeds with all three
    routes (`/`, `/documents/[id]`, `/graph`) correctly dynamic, and `next
    dev` boots and serves all three with the expected clean
    `SUPABASE_URL / SUPABASE_SERVICE_KEY are not set` 500 rather than
    crashing. The graph's actual rendering (force layout, node click,
    `:target` highlight) and the upload flow end-to-end are **not**
    verified against real data/browser — can't be, no credentials or a
    browser with real corpus data available here.
- [x] **Graph deep-dive round 2** — asked "are these real links or is it
      making stuff up" (answered: real cosine-similarity math over real
      embeddings, same operator/index the future chat app will use for
      retrieval, but an honest proxy, not semantic understanding — see the
      session log entry below for the full answer). Then asked for
      improvements before loading the real corpus; picked click-to-preview,
      search-and-highlight, and topic clustering (declined live filter
      controls). All three built on `main` (still no real Supabase here):
  - **Click-to-preview panel:** clicking a chunk node no longer navigates
    away — it opens a side panel (`GraphPreviewPanel`) showing the full
    chunk content, section/page/extraction-path/token-count, and its
    similarity-scored neighbours (clickable, so you can "surf" the graph
    from inside the panel). Content is fetched on demand per click
    (`getChunkContent` server action) rather than shipped for every node up
    front, so the initial `/graph` payload stays light as the corpus grows
    — the page now only fetches lightweight chunk metadata, not `content`.
    A "Open in document" link still does the full navigate-and-highlight
    when you want complete context.
  - **Search-and-highlight:** a search box embeds the query with
    `input_type="query"` (a new `corpus embed-query <text> --json` CLI
    command, reusing `providers.py` rather than duplicating a NIM call in
    TypeScript) and ranks every chunk against it via a new
    `search_chunks(query_embedding, match_count)` Postgres function (same
    HNSW-indexed top-K pattern as `chunk_similarity_edges`). Matches
    highlight on the graph (real color, enlarged) while everything else
    fades — this is genuinely a live preview of what the future RAG chat
    app would retrieve for a given question, not just a graph gimmick.
  - **Topic clustering:** a "Color: cluster" toggle recolors nodes by
    connected component (union-find over the currently-displayed edges,
    computed client-side, `lib/clustering.ts`) instead of by source
    document — reveals cross-document groupings (e.g. every manual's
    zone-wiring chunks clustering together regardless of manufacturer).
    Deliberately not real ML topic modeling — documented in the code as an
    honest, cheap proxy: chunks sharing a component means "there's a chain
    of similar-enough chunks connecting them," not necessarily "a human
    would call this the same topic." Clusters of 1 (orphans) fade to gray
    so real 2+-chunk groupings visually stand out.
  - **Document-level zoom-out** (built alongside clustering since it's a
    natural pairing): a "Chunks" / "Documents" toggle switches to a
    coarser graph where nodes are whole documents and edges are the
    average similarity across all cross-document chunk pairs, computed
    client-side from the same edge data already fetched (no new query).
    Clicking a document node navigates straight to it — no preview panel
    at that zoom level, since the document page already is the preview.
  - Verified the two new pure-logic pieces standalone before wiring them
    into React (this sandbox can't render canvas/DOM, so this is where the
    real correctness checking happened): the union-find clustering function
    against a hand-built graph (chain + pair + isolated node → 3 correct
    components), and the document-level aggregation logic (same-document
    edges excluded, cross-document pairs correctly averaged with a
    contributing-pair count).
  - `tsc --noEmit` clean, `next build` succeeds across all four routes,
    `next dev` still serves all of them with the expected clean
    credentials-missing error. `npm audit`: same 2 pre-existing
    Next-bundled-postcss vulnerabilities, nothing new.
  - **Not verified:** the actual click/search/cluster interactions in a
    real browser against real embeddings — needs your machine.
- [x] **Real bug found and fixed:** first live use on the laptop (M6 has
      started — real files going in now) surfaced that search was actually
      broken: `Error: No such option '--json'`. Root cause —
      `app/actions.ts`'s `searchChunks` called
      `corpus embed-query <text> --json`, but `embed-query` (unlike
      `ingest`) never had a `--json` flag defined; it always prints JSON
      unconditionally, so the flag was simply invalid. Reproduced the exact
      reported error with `CliRunner` before touching anything, fixed by
      dropping the erroneous `--json` arg from the TS call, then verified
      the corrected invocation against a monkeypatched `NIMClient`. This
      shipped broken because the CLI test coverage for `embed-query`
      (added last round) only tested the Python side in isolation and
      never exercised the exact argv `review-ui` actually sends —
      worth remembering for future CLI-from-Node integration points.
- [x] **Automatic flagging, to answer "how do I verify documents without
      reading every one":** `lib/flags.ts` — cheap heuristics computed from
      data already in the DB (no new NIM calls), explicitly documented as
      triage aids, not a correctness guarantee:
  - Zero chunks despite pages processed and `status` = review/done
    (critical — extraction likely produced nothing).
  - Low average tokens/page (extraction may have missed most content).
  - Chunks under 15 tokens (near-empty extraction).
  - >50% of a document's chunks vision-derived (higher hallucination/
    repetition risk per M3).
  - `manufacturer`/`revision` field "looks like an explanation, not a
    value" (length >40 chars or contains `(`) — targets the *exact*,
    already-observed M4 prose-in-metadata bug, not prose in general;
    verified this specific case gets flagged before wiring it in.
  - Missing `doc_type` after processing.
  - Surfaced as a **Flags** column + a "Flagged only" filter checkbox on
    the queue view (`DocumentTable.tsx`, now a client component so the
    filter doesn't need a server round-trip), and as a summary box plus
    individual `⚠ short chunk` highlighting on the document page — so a
    flagged document's problem chunk is visually obvious without reading
    every chunk to find it.
  - Verified `computeDocumentFlags`/`isChunkFlagged` standalone against 5
    hand-built scenarios (healthy doc → no flags; the real M4 prose case →
    correctly flagged; zero-chunks → critical; 70%-vision doc → flagged;
    a still-processing document → correctly *not* flagged yet) before
    wiring into React.
  - `tsc --noEmit` clean, `next build` succeeds across all four routes,
    `next dev` still serves them with the expected clean error.
- [ ] **Needs to happen on your machine:**
  1. `git pull`. `npm install` isn't needed (no new dependency). Apply the
     `search_chunks` migration if you haven't already (from right before
     the bug report).
  2. `npm run dev`, retry the search that failed — should actually return
     highlighted matches now.
  3. **Search:** type something you know is in a loaded manual, confirm
     matches highlight and look plausible.
  4. **Flags:** open the queue view, check the new Flags column and
     "Flagged only" toggle. As real manuals go in via M6, this is now the
     actual answer to "verify without reading everything" — open only
     what's flagged, spot-check a couple of unflagged ones occasionally to
     calibrate trust in the heuristics, don't feel obligated to open every
     document.
  5. **Preview panel + clustering:** still worth checking now that search
     works (clicking a node, cluster coloring) — see prior entry for what
     to look for.
  6. Once confirmed, keep loading the real corpus (M6) — flag anything
     that still trips you up.
- [x] **Cleaning stage added** (new pipeline stage between extraction and
      chunking, per explicit spec — see §4 Stage 2.5, §9 for the two
      decisions it required). Built on `main` (sandbox again has no real
      Supabase/NIM — verified with pure-function tests + monkeypatched-DB
      integration scripts, not real data):
  - `pipeline/corpus/clean.py`: `detect_furniture`/`is_structural_page`/
    `clean_pages` are pure, DB-free (the actual unit-test surface);
    `clean_document` is the I/O wrapper (reads `pages/`, writes
    `cleaned/pages/` + `furniture.json`, enforces the safety rail). Reused
    `chunk.py`'s table-detection heuristic (made public as `is_table_block`)
    so "is this line in a table" agrees between cleaning and chunking.
  - `chunk.py`: reads from `cleaned/pages/` now, not raw `pages/`. Added
    `apply_runt_handling` (merge/tag <50-token chunks) as a post-processing
    pass, and threaded a `structural` flag through `Block`/`_finalize`
    alongside the existing `extraction_path` combination pattern.
  - `db.py`: added `delete_chunks` (used by `restore-furniture`, which
    replaces rather than skips existing chunks since the cleaned text
    itself changes).
  - `cli.py`: `_process` now runs extract → metadata → **clean** → chunk →
    embed, stopping before chunk/embed if cleaning's safety rail tripped
    (checks `report["safety_rail_triggered"]`, verified with monkeypatched
    stage functions that `chunk_document`/`embed_document` are genuinely
    never called in that case, and genuinely *are* called in the normal
    case). New `corpus restore-furniture <id> <line>` command.
  - `supabase/migrations/..._cleaning_stage.sql`: `documents.metadata`
    column (mirrors `chunks.metadata`); `chunk_similarity_edges` and
    `search_chunks` updated to exclude structural/runt chunks (respecting
    `retrieval_override`), keeping review-ui's graph/search consistent with
    the new "must exclude from similarity search" rule from §9.
  - **Two real bugs found and fixed while building/testing this, not
    shipped broken:**
    1. My first `apply_runt_handling` excluded *any* already-tagged chunk
       as a merge target, including ones tagged `'runt'` by an earlier
       iteration of the same pass — this broke cascading merges (three
       consecutive tiny same-section chunks became three isolated
       `'runt'`-tagged chunks instead of merging into one). Caught by an
       ad hoc script before it ever reached a pytest file; fixed by only
       excluding `'structural'` chunks as merge targets, and re-evaluating
       (clearing) the `'runt'` tag if a merge pushes the combined chunk
       back over the 50-token threshold.
    2. My first pass at `clean_pages` rejoined a page's kept lines with a
       flat `"\n".join()`, losing the blank-line paragraph boundaries
       between blocks — would have silently broken `chunk.py`'s
       paragraph-based splitting on every cleaned document. Caught by a
       dedicated test (`test_paragraph_structure_is_preserved_after_stripping`)
       before it was wired into `chunk_document` at all; fixed by rebuilding
       cleaned text block-by-block (`"\n\n".join` between blocks,
       `"\n".join` within one), matching the original paragraph structure
       exactly minus the stripped lines.
  - Also hit and fixed several of my own **test-fixture** bugs (not logic
    bugs) while writing `test_clean.py`: synthetic "body text" built by
    templating a changing page number into otherwise-identical sentences
    is itself repetitive enough after normalisation to register as
    furniture, contaminating several "this should NOT be flagged" control
    assertions. Fixed by using genuinely distinct sentences per page
    instead of a number-substitution template — worth remembering for any
    future furniture-detector tests.
  - `tests/test_clean.py` (14 tests: repeated footer detected + stripped,
    repeated table row never stripped, repeated safety-warning line never
    stripped even though it'd otherwise qualify, coincidental low-frequency
    repetition not flagged, >80-char lines never flagged, documents under 5
    pages never flag anything, threshold formula, structural-page detection
    x3, structural flag propagation, restore-override exemption, paragraph
    structure preservation) + 10 new tests in `test_chunk.py` for
    `apply_runt_handling` and structural metadata propagation. 65/65 passing
    pipeline-wide.
  - Integration-verified (monkeypatched `db`, synthetic multi-page
    documents, no real Supabase/NIM) three end-to-end scenarios: realistic
    document with a footer + TOC page (footer stripped, TOC tagged
    structural, safety rail correctly does *not* block chunking); sparse
    document where the footer dominates (safety rail correctly trips,
    `status=review` + warning, zero chunks ever created); and
    `proceed_override` correctly unsticking a previously-flagged document
    on re-evaluation without needing to regenerate cleaned files.
  - review-ui: new "Cleaning" tab (`?tab=cleaning`) on the document page —
    furniture lines with per-line Restore buttons (shells out to
    `restore-furniture`, backgrounded like retry/upload), structural/runt
    chunks with an "Include in retrieval" toggle (direct JSONB metadata
    merge, no re-processing needed), and a safety-rail warning banner with
    "Proceed anyway" when applicable. Chunks tab now badges structural/runt
    chunks inline (greyed out) too, not just in the dedicated tab. Queue
    view's flag system (`lib/flags.ts`) updated: the existing "short chunk"
    flag now excludes chunks the new pipeline already tagged/handled (no
    double-counting), and a new critical flag surfaces the cleaning safety
    rail directly in the queue table, not just on the document page.
  - `tsc --noEmit` clean, `next build` succeeds across all four routes
    (still `/`, `/documents/[id]`, `/graph` — no new route), `next dev`
    still serves them with the expected clean credentials-missing error.
- [ ] **Needs to happen on your machine:**
  1. `git pull`. `cd pipeline && pip install -e ".[dev]"` (no new deps,
     but reinstall is cheap and safe), `pytest` → expect 65 passed.
  2. Apply the new `cleaning_stage` migration (adds `documents.metadata`,
     updates the two RPC functions) the same way prior migrations were
     applied.
  3. `cd review-ui && npm install` (no new deps here either), `npm run dev`.
  4. Run a real document through `corpus watch`/`ingest`+`process` and
     check: does `furniture.json` (or the Cleaning tab) list plausible
     header/footer lines, or is it too aggressive/not aggressive enough?
     Does a real TOC page in one of the actual manuals get tagged
     structural? Any real safety-warning line that repeats across pages —
     confirm it survives (check the Cleaning tab does *not* list it, and
     that it's genuinely present in the chunked content).
  5. If a document trips the >15% safety rail on real content, that's the
     first real test of whether 15% is the right threshold — worth noting
     whether it was a correct catch (heuristic genuinely misfired) or a
     false alarm (revisit the threshold/exceptions if so).
  6. Try the Cleaning tab for real: restore a furniture line and confirm
     it actually comes back after the background re-clean/re-chunk/
     re-embed finishes; toggle a structural/runt chunk's "Include in
     retrieval" and confirm it's reflected immediately (no re-processing
     needed for that one).
  7. Once confirmed, this feature is done — keep loading the real corpus
     (M6).
- [x] **Reprocess controls added to the review UI** (queue view: reprocess
      a single document from a chosen stage, or hard-reset it entirely).
      Built on `main` (sandbox again has no real Supabase/NIM — verified
      with pytest + monkeypatched-DB tests, `tsc`/`next build`, and a local
      `next dev` smoke test hitting the new routes; not run against real
      data/browser):
  - **Prerequisite refactor**: `corpus reprocess`/`corpus reset` did not
    exist anywhere before this session (confirmed by reading `cli.py` in
    full first). Added `pipeline/corpus/reprocess.py` with two importable
    functions — `reprocess_document(document_id, from_stage)` and
    `reset_hard(document_id)` — and made `cli.py`'s new `reprocess`/`reset`
    commands thin wrappers around them, matching every other stage's
    module/CLI split (extract.py, clean.py, chunk.py, embed.py).
  - `reprocess_document` reuses the same "delete what the stage's own
    resumability guard checks, then call the normal stage function" pattern
    `restore-furniture` already established: `from_stage='clean'` force-
    recleans (subject to the same safety rail — stops before chunk/embed if
    triggered, same as a normal run), `'chunk'` keeps the existing cleaned
    pages and just deletes+rebuilds chunks, `'embed'` keeps the existing
    chunk rows and only clears their embeddings (new `db.clear_chunk_embeddings`)
    so `embed_document`'s null-only resumability doesn't see "nothing to
    do." Because every stage's write is one bulk insert/update, there's no
    partially-torn-down state possible after a crash mid-reprocess — running
    it again from the same stage always starts clean, satisfying the task's
    idempotency requirement without any special recovery path. Sets
    `status='queued'` up front so the queue view shows activity immediately,
    even during the part of `'clean'` before `chunk_document`/`embed_document`
    set their own in-progress statuses.
  - `reset_hard` looks up `file_hash` first, deletes the `documents` row
    (new `db.delete_document`, cascades to chunks per the existing FK), then
    removes `work/<hash>/` and `store/<hash>.pdf` from disk.
  - `pipeline/tests/test_reprocess.py`: 11 tests against a hand-rolled
    `FakeDB` that records call order (not just call presence) — this
    matters because e.g. `delete_chunks` must run strictly between `clean`
    and `chunk`, or `chunk_document`'s own "skip if chunks already exist"
    guard would defeat the reprocess entirely. Covers all three from-stages,
    the safety-rail-stops-early path, unknown-stage/missing-document errors,
    the failed→status='failed'+error_message path, the queued-up-front
    status write, and `reset_hard` (including tolerating an
    already-missing work dir/PDF, and rejecting an unknown document). 76/76
    passing pipeline-wide. Also smoke-tested the two new CLI commands
    directly with `click.testing.CliRunner` (mocked `db`/`reprocess`
    module) to catch wiring bugs (option names, required `--hard` flag)
    `pytest` alone wouldn't have caught.
  - review-ui: three new Route Handlers (not server actions, per explicit
    spec) — `POST /api/documents/[id]/reprocess` (body `{fromStage}`,
    validates against the three allowed stages, 404s if the document
    doesn't exist, 409s if it's currently extracting/chunking/embedding,
    otherwise spawns `python -m corpus.cli reprocess <id> --from-stage
    <stage>` detached and returns 202 immediately — same fire-and-forget
    pattern as `app/actions.ts`'s retry/upload/restore-furniture), `POST
    /api/documents/[id]/reset` (same guards, spawns `corpus reset <id>
    --hard`), and `GET /api/documents` (lightweight `id`/`status`/
    `error_message` list for polling). Extracted the pipeline-env helper
    `app/actions.ts` already had into `lib/pipeline.ts` so the two new
    route files and `actions.ts` share one copy instead of duplicating it a
    third time.
  - New `ReprocessControls` client component per document row: a split
    button (default click = reprocess from cleaning; the caret opens a
    dropdown with all three stages, showing an inline warning under the
    clean/chunk options — not under embed, since only those two actually
    delete+recreate chunk rows — if the document has any chunk with
    `metadata.retrieval_override` set) plus a small overflow menu with a
    red "Hard reset" item behind a `confirm()` dialog that spells out
    exactly what gets deleted (row, chunks, extracted pages, stored PDF)
    and that the PDF needs re-dropping into `inbox/`. Both are disabled
    while `status` is `extracting`/`chunking`/`embedding` (a new
    `IN_PROGRESS_STATUSES` export, deliberately narrower than
    `StatusBadge`'s `ACTIVE_STATUSES` — `queued` is safe to reprocess/reset,
    it hasn't started yet).
  - `DocumentTable` now polls `GET /api/documents` every 3s and merges the
    live `status`/`error_message` into each row (falling back to the
    server-rendered value until the first poll resolves) — deliberately
    *not* the existing `AutoRefresh`/`router.refresh()` mechanism, which
    re-renders the whole server component (including in-progress metadata
    edit inputs) every tick; this only touches the status badge (which
    already renders the pulsing "in progress" dot via `StatusBadge`, so no
    new spinner component was needed) and error text. Removed `<AutoRefresh
    />` from the queue page specifically, since the new polling supersedes
    it there; left it on the document detail page untouched, where it still
    serves a page this lightweight endpoint doesn't cover.
  - `app/page.tsx` now also computes a `manualChunkToggles: Map<string,
    boolean>` from the chunk metadata it already fetches (no new query) and
    passes it down for the dropdown warning.
  - `tsc --noEmit` clean, `next build` succeeds (all six routes now: `/`,
    `/api/documents`, `/api/documents/[id]/reprocess`,
    `/api/documents/[id]/reset`, `/documents/[id]`, `/graph`). Ran `next
    dev` locally and hit the new routes directly: bad `fromStage` correctly
    400s before ever touching Supabase; with no `.env.local` in this
    sandbox, all three correctly 500 with the same clean
    "SUPABASE_URL/SUPABASE_SERVICE_KEY are not set" error every other
    Supabase-touching route already gives (not a crash) — expected here,
    needs a real credentialed run to verify the actual reprocess/reset
    behavior end-to-end.
- [ ] **Needs to happen on your machine:**
  1. `git pull`. `cd pipeline && pip install -e ".[dev]"`, `pytest` →
     expect 76 passed. `cd review-ui && npm install` (no new deps), `npm
     run dev`.
  2. Reprocess the CTec manual (or any already-processed document) from the
     UI: click "Reprocess" (default, from cleaning) and watch the queue
     view's status column move through the stages live via the new 3s
     poll — confirm it actually shows queued → (cleaning happens, no
     dedicated status) → chunking → embedding → review without a manual
     page reload.
  3. Try the dropdown: reprocess from chunking, then from embedding, on a
     document with no manual chunk toggles — confirm no warning shown, and
     that "from embedding" leaves the chunk count unchanged (same rows,
     just re-embedded) while "from chunking"/"from cleaning" produce a
     fresh chunk count.
  4. Set a chunk's "Include in retrieval" toggle on a document, then open
     its reprocess dropdown — confirm the warning appears under "from
     cleaning"/"from chunking" but not "from embedding," then actually
     reprocess from cleaning and confirm the toggle is indeed gone
     afterward (expected loss, per the guard-rail warning) while a
     furniture-restore choice on the same document survives (it lives in
     `furniture_overrides.json`, not on the chunk row).
  5. Try Hard reset on a disposable test document: confirm the dialog text
     is accurate, confirm the row disappears from the queue (after
     `router.refresh()`/the next poll), and confirm `work/<hash>/` and
     `store/<hash>.pdf` are actually gone on disk.
  6. Confirm both buttons are genuinely disabled (not just visually greyed)
     while a document is extracting/chunking/embedding — e.g. click
     reprocess on one document, then immediately try clicking reprocess
     again on the same row before it reaches `review`.
  7. Once confirmed, this feature is done.
- [x] **Progress feedback added across the review UI** (queue view +
      document view), requested after trying the reprocess controls above:
      a segmented per-stage progress bar instead of a static status word,
      and a spinner on every button that kicks off a background run. Built
      on `main` (sandbox again has no real Supabase — `tsc`/`next build`
      clean, `next dev` smoke-tested, not run against real data):
  - New `components/StageProgress.tsx`: a 5-segment bar (Queued / Extract /
    Clean & chunk / Embed / Review) driven purely by `documents.status`, so
    it works for every path that moves a document through those statuses
    — initial processing, `retry`, and reprocess-from-any-stage — without
    needing to know which one triggered it. Cleaning has no dedicated
    status (see §4), so it's folded into "Clean & chunk"; `failed` renders
    as a distinct red state instead of a partial bar, since status alone
    doesn't say which stage actually failed. Replaces `StatusBadge` in the
    queue table's Status column and is now shown prominently on the
    document detail page (previously just a small colored status word next
    to the manufacturer/model line).
  - **Removed `components/StatusBadge.tsx` entirely** rather than leaving
    it as dead code — `StageProgress` replaced its only two call sites.
    Its `ACTIVE_STATUSES` constant (still needed by `AutoRefresh` gating
    and the live-status poll) moved to `lib/types.ts`, next to the
    `IN_PROGRESS_STATUSES` constant added for reprocess/reset guarding.
  - New `components/Spinner.tsx` (small inline SVG) and
    `components/PendingSubmitButton.tsx` (a `useFormStatus`-based
    drop-in for a plain form submit button, extracted from the pattern
    `UploadForm`'s submit button already used) — wired into Retry,
    Approve, Proceed-anyway, restore-furniture's per-line Restore button,
    and `ConfirmSubmitButton` (Delete). `ReprocessControls`'s own buttons
    get the same spinner treatment keyed off its existing `pendingAction`
    state (renamed from a plain boolean specifically so the two buttons —
    Reprocess and Hard reset — can each show their own spinner rather than
    both lighting up for either action). All of this only covers the
    request itself being in flight (a network round trip to kick off a
    detached background process); `StageProgress`'s live 3s poll is what
    shows the actual multi-minute pipeline run progressing afterward.
  - `tsc --noEmit` clean, `next build` succeeds across all six routes,
    `next dev` still gives the same clean credentials-missing 500 on every
    Supabase-touching route (confirms nothing broke, not a real
    end-to-end check).
  - **Furniture question, resolved (indirectly)**: asked why furniture
    detection only found two repeated lines on the real 46-page Enforcer
    V11 manual. Couldn't diagnose blind, but the follow-up report (`/graph`
    neighbor labels reading `**Page Number:** 4` on many different real
    pages — p.4, p.5, p.6, p.7, p.8, p.9, p.13, ...) turned out to be the
    same underlying issue seen from a different angle — see below.
- [x] **Fixed a real chunking bug: bold "field: value" vision artifacts
      were being classified as section headings.** Root-caused from the
      `/graph` complaint above: `chunkLabel()` (`GraphExplorer.tsx`)
      builds a node's label from `chunk.section`, and clicking a
      "related chunk" jumps straight to that chunk — so a wrong `section`
      makes the whole graph look both mislabeled *and* miswired ("click on
      one, it goes to different stuff"), even though the similarity edges
      and click behavior were both working correctly the whole time. The
      actual defect was upstream in `chunk.py`: `_is_heading()` classifies
      any short, single-line, no-trailing-punctuation paragraph as a
      section heading — which also matches a vision-transcribed
      `**Page Number:** 4`-style bold field line (a data value, not a
      title). Once picked up as a heading, it becomes `chunk_section` /
      `last_heading` for every chunk after it until the next real heading,
      so many unrelated chunks across many different real pages all ended
      up labeled with the same misleading text — explaining both "the
      labels don't make sense" and "clicking one goes to unrelated
      content" (the content was never wrong, only the label). This also
      explains the furniture question from the same session, without
      needing the raw-page sample I'd asked for: a field whose literal
      value is constant garbage (always "4", not the real page number)
      would still only be present on the subset of pages that went through
      the vision path, likely below `FURNITURE_MIN_PAGE_RATIO` of the
      *whole* 46-page document — so it never crossed the furniture
      threshold, survived cleaning as ordinary text, and then got
      misclassified as a heading by `chunk.py`. Fixed with a new
      `_FIELD_VALUE_LINE_RE` guard in `_is_heading()` (excludes lines
      matching `^\*\*[^*\n]+:\*\*`) — the field text itself still ends up
      in chunk content (a separate, lower-priority content-quality
      question, not addressed here), it just no longer becomes `section`.
      2 new tests confirming the field-value line doesn't become
      `section` and doesn't overwrite a real preceding heading (78/78
      pipeline-wide). Not verified against the real document — needs a
      **reprocess from 'chunk'** (using the feature built earlier this
      session) to regenerate its chunks under the fix.
- [x] **Second, more general instance of the same bug class, found from a
      follow-up report on the same real document**: `/graph` neighbor
      labels reading `**Table of Contents**` on many different real pages
      (p.4, p.5, p.6, p.8, p.9, p.12, p.13, p.27, ...) — not the actual TOC
      page. The `_FIELD_VALUE_LINE_RE` fix above didn't cover this, since
      `**Table of Contents**` isn't a `Label: value` field, it's a bold
      *phrase* — same underlying weakness in `_is_heading()` (anything
      short/single-line/unpunctuated qualifies), different literal text
      vision hallucinated onto unrelated pages. Rather than special-case
      another exact string, generalized the fix: a genuine section heading
      is specific to where it appears and essentially never repeats
      verbatim within one document, so `chunk_pages` now does a
      document-local pre-pass (`_find_repeated_heading_texts`, new) that
      collects every heading-shaped line across all pages, normalizes it
      (strips `#`/`*` markdown + case), and excludes any that appear on 3
      or more distinct pages from being classified as a real heading at
      all (`_is_heading` now takes that set and checks against it,
      alongside the existing field-value guard). Deliberately a much lower
      bar than clean.py's furniture detector (~30% of the document): a
      short heading legitimately reused 2x in a 46-page manual is still
      allowed as a real heading, but the false-positive cost of wrongly
      excluding a genuinely-3x-reused heading is low anyway (the chunk
      keeps its full content either way — it just falls back to whichever
      real heading actually preceded it), so it's worth catching repeats
      the page-ratio threshold would miss. This also explains the original
      furniture-detection question from two sessions ago without ever
      getting the raw-page sample that was asked for: a hallucinated
      phrase repeated only across the vision-processed subset of pages
      (not the full 46) plausibly never crosses `FURNITURE_MIN_PAGE_RATIO`
      either. 5 new tests (unit tests for `_normalize_heading_text`/
      `_find_repeated_heading_texts`/`_is_heading`'s threshold behavior,
      plus one `chunk_pages`-level end-to-end case reproducing the exact
      "Zone Wiring real heading survives, Table of Contents repeated
      3x doesn't" scenario) — 83/83 pipeline-wide. Not verified against
      the real document; same **reprocess from 'chunk'** step covers both
      this and the field-value fix above in one pass.
- [ ] **Needs to happen on your machine:**
  1. `git pull`. `cd pipeline && pip install -e ".[dev]"`, `pytest` →
     expect 83 passed. `cd review-ui && npm install` (no new deps), `npm
     run dev`.
  2. Open the queue view and confirm the new segmented progress bar
     renders sensibly for a document in each state (queued, mid-pipeline,
     review, done, failed) — check it against a document you kick off a
     reprocess on, same as the prior checklist above.
  3. Click Retry / Approve / a Restore-furniture-line button / Reprocess
     and confirm each shows a spinner immediately (not just a disabled
     look) for that first moment, then hands off to the progress bar.
  4. Reprocess the Enforcer V11 document **from 'chunk'** (chunks only —
     cleaned pages don't need to change) and reopen `/graph`: confirm
     neither `**Page Number:** 4` nor `**Table of Contents**` show up as
     node/neighbor labels anymore, and that clicking a related chunk now
     visibly makes sense relative to its label. If a *different* garbage
     label pattern survives this fix, paste it — that's the concrete data
     needed to extend the guard rather than guessing at a broader pattern
     up front. Also worth eyeballing whether the 3-distinct-pages
     threshold is too aggressive on a real corpus (a legitimately-reused
     heading losing its `section` label 3+ times in) — if so, it's a
     one-constant change (`_MIN_REPEATED_HEADING_PAGES` in `chunk.py`).
- [x] **Bulk folder drop.** Asked about auto-discovering/scraping manuals
      from the internet; discussed the idea rather than building it
      straight away (real accuracy/legal/site-fragility concerns for
      autonomous discovery — see session log), and the user picked the
      lower-risk, immediately useful piece instead: making it faster to
      load many manuals at once without a scraper. Built on `main`
      (sandbox still has no real Supabase/NIM):
  - New `corpus ingest-dir <directory> [--process]` CLI command: ingests
    every `*.pdf` directly inside a folder in one shot (the one-shot
    alternative to dropping files in `inbox/` and leaving `corpus watch`
    running indefinitely). Duplicates skipped like a normal ingest; one
    bad PDF is reported and skipped, not fatal to the batch — same
    per-file failure handling `watch` already uses. `--process` additionally
    runs the full pipeline for each newly-ingested document, sequentially,
    reusing `_process` (no new pipeline logic, pure orchestration in
    `cli.py`, consistent with how every other command is just a thin
    wrapper). 5 new tests in a new `tests/test_cli.py` (the project's
    first CLI-level test file — uses `CliRunner` + monkeypatched
    `intake.ingest`/`_process` to verify the batch/duplicate-counting/
    one-bad-file-doesn't-abort-the-rest logic without needing a real
    PDF or Supabase). 88/88 pipeline-wide.
  - review-ui: `UploadForm`'s file input now takes `multiple` — select one
    PDF or many (ctrl/cmd-click, or select-all inside a folder) in the
    browser's native picker. `uploadDocument` in `app/actions.ts` keeps
    the original single-file UX exactly (redirect straight to that
    document, errors surface directly) when exactly one file is selected;
    for multiple files it ingests each in turn, catches per-file failures
    without aborting the batch, and redirects to the queue with a summary
    banner (`?bulkUploaded=N&bulkDuplicates=N&bulkFailed=N`). Each
    ingested document still gets its own independent detached background
    `corpus process` call, so a slow/vision-heavy manual in the batch
    doesn't hold up the others.
  - Deliberately did not build actual folder drag-and-drop (browser
    `DataTransferItem`/`webkitGetAsEntry` handling) — the native multi-select
    file picker already covers "select everything in a folder at once"
    without that extra complexity; can add real drag-and-drop later if it
    turns out to matter in practice.
  - `tsc --noEmit` clean, `next build` succeeds across all six routes,
    `next dev` smoke-tested locally (same expected credentials-missing
    500). Not verified against real Supabase/NIM or a real multi-file
    browser upload.
- [ ] **Needs to happen on your machine:**
  1. `git pull`. `cd pipeline && pip install -e ".[dev]"`, `pytest` →
     expect 88 passed. `cd review-ui && npm install` (no new deps), `npm
     run dev`.
  2. Try `corpus ingest-dir <a folder with a few PDFs>` (no `--process`
     first) and confirm it lists each, correctly skips anything already
     ingested, and reports an accurate summary count. Then try it again
     with `--process` on a fresh folder and confirm each document actually
     starts processing (check `corpus status` or the queue view).
  3. In the browser, select multiple PDFs at once in the upload form and
     confirm: the summary banner shows correct counts, every non-duplicate
     document appears in the queue and starts processing independently,
     and a deliberately-bad/corrupt "PDF" in the batch gets reported as
     failed without stopping the other uploads.
  4. Confirm the single-file upload path still behaves exactly as before
     (redirects straight to the new document's page).
- [x] **Real upload progress bar**, requested after trying bulk upload —
      the spinner/"Uploading…" state gave no sense of how much had
      actually transferred. Built on `main` (sandbox still has no real
      Supabase/NIM):
  - The blocker: `<form action={serverAction}>` (what upload used until
    now) only exposes a `pending` boolean via `useFormStatus` — there's no
    way to observe bytes-sent through a Server Action. Real upload
    progress needs `XMLHttpRequest`'s `upload.onprogress` (`fetch` has no
    cross-browser upload-progress API), which means the request has to go
    through an actual endpoint the client controls, not a server action.
  - Moved upload off `app/actions.ts` entirely onto a new
    `POST /api/documents/upload` Route Handler (same reasoning as the
    reprocess/reset routes from earlier this session: client needs finer
    control than a server action gives). It accepts one or more files,
    does the same per-file ingest-then-detached-process work the old
    `uploadDocument` server action did (one bad PDF doesn't abort the
    batch), and returns a JSON summary instead of doing an HTTP redirect
    (the client decides where to navigate, since it's driving the
    request). The shared `ingestOne`/`startProcessing` helpers moved from
    `app/actions.ts` into `lib/pipeline.ts` so both this route and (later)
    anything else can use them without duplicating the subprocess-spawn
    logic.
  - `UploadForm` rewritten as a self-contained client component: reads
    selected files via a ref (no more native form submission), POSTs them
    with a hand-rolled `XMLHttpRequest` wrapped in a Promise, and renders
    an actual percentage progress bar driven by `upload.onprogress`. Once
    byte transfer hits 100% there's necessarily still a gap before the
    server responds (hashing + DB insert per file) — shown as an
    indeterminate "Finalizing…" pulse rather than a bar stuck at 100%
    looking stalled. Single-file upload still redirects straight to that
    document's page; multi-file still redirects to the queue's existing
    `?bulkUploaded=`/`bulkDuplicates=`/`bulkFailed=` summary banner — both
    now client-initiated (`router.push`) instead of server-side `redirect`.
  - Deleted `uploadDocument` from `app/actions.ts` outright (fully
    replaced, not left dead) and pruned the imports (`randomUUID`, `os`)
    that were only used there. Also removed `next.config.ts`'s
    `experimental.serverActions.bodySizeLimit: "50mb"` override — that
    existed specifically because uploads went through a Server Action
    (which defaults to a 1mb body cap); Route Handlers have no such cap on
    this local-only app, so the override no longer does anything and the
    stale comment would have been actively misleading left in place.
  - `tsc --noEmit` clean, `next build` succeeds across all seven routes
    (new: `/api/documents/upload`). `next dev` smoke-tested locally: an
    empty POST 400s cleanly, and a POST with a real multipart file
    correctly reaches (and fails on) the expected
    `CORPUS_PYTHON`/`CORPUS_PIPELINE_DIR` missing-env error — confirms the
    multipart parsing and route wiring work, not the real upload/ingest
    path (no real pipeline env or browser `XMLHttpRequest` available in
    this sandbox).
- [ ] **Needs to happen on your machine:**
  1. `git pull`, `npm install` (no new deps), `npm run dev`.
  2. Upload a real (multi-MB) manual PDF and actually watch the progress
     bar move — confirm it reads sensibly (0→100%, then "Finalizing…"
     briefly, then navigates to the document page). Try a multi-file
     upload too and confirm the same bar tracks the combined batch.
  3. Confirm a large file no longer hits any body-size-limit error now
     that the old `serverActions.bodySizeLimit` override is gone (Route
     Handlers shouldn't need one here, but this is the first real check of
     that assumption).
  4. Re-run the bulk-upload checklist from the previous entry (duplicate
     handling, a deliberately-bad file, single-file redirect) since the
     whole upload path was rewired, not just the progress bar layered on
     top.

## 11. Session log

| Date | Session summary | Next step |
|---|---|---|
| — | Project planned, STATUS.md created | Begin M1 |
| 2026-07-17 | M1 skeleton built on `main`: repo layout, `pipeline/` package (config, providers, db, cli stub, intake), `db/schema.sql`, chunk test scaffold. All committed directly to main per new workflow (no per-session branches). Verified `corpus check` degrades gracefully with no `.env`, `pytest` passes. | Fill in real `.env` values, apply schema to Supabase, run `corpus check` to confirm embedding dims, then start M2 (text-path happy path with one clean manual). |
| 2026-07-18 | M1 finished: moved schema to `supabase/migrations/` + `config.toml` for the GitHub integration; renamed `.env.example` → `.env` and filled in real credentials; fixed local Norton SSL interception breaking Python HTTPS; caught a publishable-key-in-service-key-slot mistake; migration didn't auto-apply via the GitHub integration within ~3 min so applied it manually over `DATABASE_URL`. `corpus check` now fully green (Supabase reachable, tables exist, NIM embed confirms 1024 dims). | Confirm in the Supabase dashboard whether the GitHub integration is actually linked (Project Settings → Integrations → GitHub) so future migrations auto-apply; if not, keep using the manual `DATABASE_URL` apply. Then start M2. |
| 2026-07-18 | M2 built on `main` (different session/sandbox than M1 — no `.env` here, so nothing was run against real Supabase/NIM). Implemented real `extract.py`/`chunk.py`/`embed.py`, added `corpus process`/wired `watch` to run the full pipeline, added `paths.py`. Unit-tested the chunker (7 passing tests) and smoke-tested PyMuPDF extraction against a synthetic PDF. | Run it for real: `git pull`, install, `pytest`, then feed it an actual manual via `corpus watch` and check the `chunks` table. Report back so M3 (vision path) can start. |
| 2026-07-18 | Pulled M2 onto the laptop and ran it against real Supabase/NIM: `pytest` 7/7, then a synthetic 3-page PDF through `ingest` → `process` → verified `documents`/`chunks` rows in Supabase (table + procedure stayed intact in one chunk, embedding genuinely 1024 dims), then cleaned the test doc out. Mechanics confirmed working end-to-end. | Run the same flow against a real manual (not synthetic) to sign off M2 for real, then start M3 (vision path + triage) once `NIM_VISION_MODEL` is set. |
| 2026-07-18 | M3 built on `main` (sandbox again has no `.env`). Added triage (`needs_vision`: thin-text-but-not-blank, or table-dense heuristics) and the vision extraction path to `extract.py`, a page-marker format so `chunk.py` knows which pages were vision-derived, and per-chunk `extraction_path` propagation. 10 new tests (17/17 total). Manually traced triage → page files → chunking against a synthetic mixed text/scanned PDF with the actual NIM call simulated (no credentials in this sandbox). | Run it for real: pull, install, `pytest` (17 passed expected), confirm `NIM_VISION_MODEL` is set, then feed it an actual scanned/table-heavy manual and check `chunks.extraction_path` + content quality in Supabase. Report back so M4 (metadata inference + failure handling) can start. |
| 2026-07-18 | Pulled M3, `pytest` 17/17, set `NIM_VISION_MODEL=meta/llama-3.2-11b-vision-instruct` (was blank). Ran a synthetic mixed-content PDF (prose/scanned-looking/table-dense pages) through the real pipeline: triage routed all three pages correctly, and vision genuinely improved on a dense table PyMuPDF would've flattened. **Also found the vision model can fall into a degenerate repetition loop on grid-like content** — repeated a 20-row table ~30 times until hitting `max_tokens=4096`, which the chunker then dutifully packed into several near-duplicate chunks. Not a chunker bug; a missing safeguard between the vision call and the DB insert. Cleaned up the test document afterward. | Decide how to guard against vision repetition loops (detect+truncate, lower max_tokens, different model, or accept-and-catch-in-review-later) before trusting M3 on a real manual. Then test on an actual scanned/table-heavy PDF and start M4. |
| 2026-07-18 | Added `_detect_repetition` to `providers.py` (requested addition to M3): truncates a vision response that loops on the same paragraph/short cycle 3+ times in a row, called right before `vision_transcribe` returns. First implementation used a `difflib` fuzzy-similarity fallback for "near-exact" matching; a test with a long legitimate incrementing table (`Zone 0/Addr 000`, `Zone 1/Addr 001`, ...) caught it wrongly collapsing the table to one row, because sequential rows differing by one digit are >90% similar by that metric. Fixed by dropping the fuzzy fallback — "near-exact" is now whitespace-normalization only, which still catches real repeat loops without conflating them with genuinely-different similar-looking rows. 10 new tests (27/27 total), including a regression test for that false positive. | Pull and run `pytest` (27 passed expected) on the laptop; no live vision call needed to verify this since it's pure text-in/text-out, but worth eyeballing `chunks.content` next time a real vision-heavy manual goes through, in case a genuine repeat loop shows up and gets truncated. Then M4 (metadata inference + failure handling). |
| 2026-07-18 | Pulled the repetition-loop fix, `pytest` 27/27. Re-ran the same synthetic repro PDF live — this time the model didn't reproduce the exact runaway loop (only echoed the table twice inside a hallucinated narrative, which is correctly left alone since the rule is "more than twice"). Since live calls aren't reliably reproducible, verified the fix more directly: fed the exact originally-captured 30x-repeated text straight into `_detect_repetition` and confirmed it truncates cleanly to one copy. Also reconfirmed the hallucination-on-blank-page issue is real (separate, still-open, not addressed by this fix). Cleaned up the test document. | Test against a real scanned/table-heavy manual (not synthetic) and eyeball chunk quality in Supabase. Decide later whether the hallucination-on-low-content-page risk needs a guard. Then start M4. |
| 2026-07-18 | Tested M3 against a real manual (Pyronix Enforcer V11 install guide, 16 pages) for the first time. Legitimate vision pages (real tables/diagrams) transcribed accurately. Confirmed the hallucination risk for real: the back cover (solid color blocks + logo, zero real content) made the vision model fabricate an entire fake manual with invented specs/warranty/phone number. First fix attempt (prompt sentinel asking the model to say "NO_CONTENT") failed outright — the model ignored it and hallucinated something different instead. Real fix: `_is_flat_graphic(page)` in `extract.py`, a row-coverage pixel-variance heuristic that keeps flat-design pages off the vision path entirely rather than trusting the model to decline. Validated directly against the real page repeatedly during development (a naive cell-fraction version wrongly still let the real cover through; row-coverage fixed it). 6 new tests (33/33 total). Re-ran the real document end to end: chunk count correctly dropped 9→8, no fabricated chunk. Accidentally deleted the real ingested document during test cleanup (autopilot from the synthetic-test pattern); caught it, asked, left deleted per instruction — source PDF untouched in Downloads. | M3 is done (mechanics + the one real quality issue found). Start M4 (metadata inference + failure handling), needs `NIM_LLM_MODEL` set. Residual: `_is_flat_graphic` only catches flat-color-block pages, not other hallucination shapes — revisit if a different manual surfaces one. |
| 2026-07-18 | M4 built on `main` (sandbox again has no `.env`). Added `metadata.py` (LLM metadata inference, resumable, wired into `_process` as best-effort/non-fatal). Implemented `corpus retry` for real — found and fixed a resumability gap along the way: `chunk_document` was re-inserting a duplicate chunk set on every call, which would have defeated `embed_document`'s resumability (and wasted NIM quota) on a retry-after-embed-failure; fixed with a `db.count_chunks` existence check, mirroring how extract/embed already skip completed work. 8 new tests (41/41 total); also manually verified (monkeypatched DB/NIM) that both `infer_metadata` and `chunk_document` correctly skip redoing work on a second call. | Pull, install, `pytest` (41 passed expected), set `NIM_LLM_MODEL`, then run metadata inference against a real manual and check the `documents` row. Test `corpus retry` against a real induced failure to confirm it resumes cleanly without wasting NIM calls. Then M5 (review UI). |
| 2026-07-18 | Pulled M4, `pytest` 41/41, set `NIM_LLM_MODEL=meta/llama-3.3-70b-instruct` (was blank). Metadata inference on the real Enforcer V11 manual: panel_model/doc_type/revision came back clean, but `manufacturer` came back with the model's reasoning baked into the value instead of a clean string (e.g. `"Pyronix (implied, not explicitly stated but...)"`)  — reproduced the same pattern on a second document, confirming it's systemic, not a fluke. `corpus retry` tested against a genuine forced failure (bogus embed model), not just idempotency: confirmed failed→retry→review with the error cleared, no duplicate chunks, no wasted NIM calls on stages that already succeeded — also confirmed 0 wasted work retrying an already-successful document. Cleaned up both test documents afterward (source PDFs untouched). | Decide how to stop the LLM from writing prose into manufacturer/revision fields (tighten prompt further vs. add post-processing validation) before M5's review UI needs to show these as clean editable fields. Otherwise M4 is done — start M5 (review UI). |
| 2026-07-18 | M5 built on `main` (sandbox again has no real Supabase): `review-ui/`, a minimal Next.js 16 App Router + TypeScript + Tailwind v4 app with the queue view and document view from STATUS.md §5. Queue view's metadata fields are plain editable inputs (not read-only) specifically because of the prose-in-manufacturer/revision finding from the last session — review here means "look and fix," which is the mitigation for that still-open decision. Retry button shells out to `python -m corpus.cli retry <id>` as a detached background process rather than reimplementing retry logic in JS. Hit and root-caused a real build break: `npm install` resolved `typescript` to `7.0.2`, which crashed Next's internal type-check with an opaque low-level Node error; pinned to `^5.9.3` (what Next 16.2.10 actually expects) after confirming via `ignoreBuildErrors` that the crash was specifically in the TS step. `next build` (Turbopack, the default) succeeds cleanly; noted but didn't chase a separate `--webpack` path-alias resolution failure since Turbopack is what this app actually uses. `next dev` boots and both routes correctly fail with a clean "SUPABASE_URL / SUPABASE_SERVICE_KEY are not set" 500 rather than crashing, since no real Supabase is reachable from here. | Pull, `npm install`, set up `review-ui/.env.local` from the example (same Supabase creds as `pipeline/.env`, plus CORPUS_PYTHON/CORPUS_PIPELINE_DIR for Retry), `npm run dev`, and actually use it in a browser against real data: open a document, check chunk rendering, edit/confirm metadata, approve a review-status doc, retry a failed one if any exist, delete a disposable test doc and confirm its chunks vanish too. Then M5 is done — M6 is loading the real 5-panel corpus, no more code needed for that. |
| 2026-07-18 | Tried the M5 review UI and gave feedback: no way to add a document from the UI, no visual way to see how documents/chunks relate, and the UI generally isn't user-friendly (asked specifically: no progress feedback, bare-bones design, hard to navigate). Confirmed chunk-level (not document-level) similarity graph is what's wanted, to be built now rather than deferred past M6. Built on `main` (sandbox still has no real Supabase): upload form + `uploadDocument` server action + `corpus ingest --json`; `/graph` page using `react-force-graph-2d` + a new `chunk_similarity_edges` Postgres function (HNSW-indexed per-chunk nearest-neighbours, not a full pairwise scan) exposed via Supabase RPC; persistent nav header, card-based layout, `AutoRefresh` polling component, and a pulsing status-dot for in-progress documents. `tsc`/`next build` clean across all three routes; `npm audit` shows no new vulnerabilities from the new dependency. Upload flow and graph rendering not verified against real data/browser (no credentials here). | Pull, `npm install`, apply the new `chunk_similarity_edges` migration, `npm run dev`, and actually use it: upload a real PDF, confirm it starts processing; open `/graph` once chunks are embedded and check nodes render/color/link correctly and clicking one highlights the right chunk; sanity-check the auto-refresh and new layout feel like a real improvement. Then this follow-up round (and M5 overall) is done — on to M6. |
| 2026-07-18 | Asked whether the graph edges are "real links or making it up." Answer given: real cosine similarity over real embeddings (same pgvector operator/HNSW index the future chat app will use for retrieval at query time), not fabricated — but honestly limited to "these texts read as linguistically similar," which usually but not always tracks genuine topical relevance (boilerplate/table-structure text can false-positive; genuinely related content phrased differently can false-negative), and the 0.78/top-5 defaults are unvalidated guesses since there's barely any real corpus loaded yet. Then asked for improvements to actually understand the corpus before adding real files; picked click-to-preview, search-and-highlight, and topic clustering (declined a live threshold-filter slider). Built on `main` (still no real Supabase): `GraphPreviewPanel` (click a node, see full content + scored neighbours in a side panel, content fetched on demand via a new `getChunkContent` action so the graph page itself stays lightweight — dropped `content` from its chunk query entirely); search box wired to a new `corpus embed-query --json` CLI command (reuses `providers.py`, doesn't duplicate the NIM call in TS) + a new `search_chunks` Postgres function, highlighting matching nodes and fading the rest; a "Color: cluster" toggle using client-side union-find over the displayed edges (`lib/clustering.ts`) as an honest, documented-as-approximate stand-in for real topic modeling; a "Chunks"/"Documents" view toggle for a document-level zoom-out, aggregated client-side from the same edge data. Verified the two new pure-logic pieces (union-find, document-edge aggregation) standalone with hand-built test graphs before wiring into React, since this sandbox can't render canvas. `tsc`/`next build` clean across all four routes, no new `npm audit` findings. Interaction behavior (actual clicks/search/clustering against real embeddings) not verified — needs a real browser and real data. | Pull, install, apply both new migrations, `npm run dev`. Confirm the preview panel loads real content, run a real search query and sanity-check the matches, and — the actually interesting test — toggle cluster coloring once more than one document is loaded and judge honestly whether same-colored chunks across manuals read as related to a human, which is the real answer to "is this actually smart." Then start loading the rest of the real corpus (M6). |
| 2026-07-18 | M6 started (real files going in), and search turned out to actually be broken: `Error: No such option '--json'` when running a real query. Root cause — `searchChunks` in `app/actions.ts` called `corpus embed-query <text> --json`, but `embed-query` (unlike `ingest`) never had a `--json` flag, it just always prints JSON; the flag was invalid and click rejected it. This shipped broken because the CLI-side test for `embed-query` only exercised the Python side directly, never the exact argv review-ui sends — a gap in how the CLI-from-Node integration points get tested. Reproduced the exact error with `CliRunner` first, then fixed by dropping the bad arg, then re-verified. Also asked how to verify documents without reading every one — built `lib/flags.ts`: cheap DB-only heuristics (zero chunks despite pages, low tokens/page, near-empty chunks, heavily-vision documents, the *specific* M4 prose-in-metadata pattern, missing doc_type), surfaced as a Flags column + "Flagged only" filter on the queue view and inline chunk highlighting on the document page. Verified the flag logic against 5 hand-built scenarios (including reproducing the real M4 prose bug to confirm it gets caught) before wiring in. `tsc`/`next build` clean, no new deps. | Pull, retry the search that failed (no reinstall needed), apply `search_chunks` if not already applied. Use the Flags column as the actual workflow going forward: open only what's flagged, spot-check a few unflagged documents occasionally to calibrate trust in the heuristics. Keep loading the real corpus. |
| 2026-07-18 | Added reprocess/hard-reset controls to the review UI, on `main` (sandbox still has no real Supabase/NIM). Neither `corpus reprocess` nor `corpus reset` existed before this session; built `pipeline/corpus/reprocess.py` (`reprocess_document`/`reset_hard`, importable, reusing the "delete what the target stage's resumability guard checks, then call the normal stage function" pattern `restore-furniture` already established) with `cli.py`'s new `reprocess`/`reset` commands as thin wrappers, plus two new `db.py` functions (`delete_document`, `clear_chunk_embeddings`). 11 new tests against a call-order-recording `FakeDB` (76/76 pipeline-wide), plus a `CliRunner` smoke test of the new CLI wiring. review-ui: three new Route Handlers (`GET /api/documents` for 3s polling, `POST .../reprocess`, `POST .../reset`, all guarded against acting on an in-progress document) instead of server actions, per explicit spec; a new `ReprocessControls` split-button+overflow-menu component (warns about losing manual chunk retrieval toggles only for the two stages that actually delete+recreate chunk rows; hard-reset behind a detailed `confirm()`); `DocumentTable` now polls and merges live status/error without a full server re-render, replacing `AutoRefresh` on the queue page specifically (left untouched on the document detail page). `tsc`/`next build` clean across all six routes; `next dev` smoke-tested locally — bad input 400s before touching Supabase, missing-credentials 500s are the same clean error every other route already gives here. Not run against real data/browser. | Pull, install both sides, `pytest` (76 passed expected), `npm run dev`. Reprocess the CTec manual from the UI and watch status move through the stages live in the queue view (the task's own acceptance test); try each dropdown stage, confirm the manual-chunk-toggle warning appears/behaves correctly, hard-reset a disposable document and confirm the filesystem state is actually gone, and confirm both controls are genuinely disabled mid-run. |
| 2026-07-18 | Tried the reprocess controls; worked, but two pieces of feedback: (1) furniture detection on a real 46-page manual (Enforcer V11 Programming Guide) only caught two repeated lines (the title header, the bare page number) — "that can't be it," expected more boilerplate to be flagged. Couldn't diagnose blind without seeing the actual raw pages (could be a threshold problem, a vision/OCR-variance matching problem, or genuinely correct for this document) — asked for a sample of what's being missed rather than guessing at a `clean.py` change; left open. (2) Wanted progress bars on running tasks generally, not just the queue's status word. Built on `main` (sandbox still has no real Supabase): new `StageProgress` component (segmented Queued/Extract/Clean&chunk/Embed/Review bar driven by `documents.status`, works for every path that moves a document through those statuses — processing, retry, reprocess — without knowing which one triggered it), replacing `StatusBadge` (deleted entirely, not left as dead code; its `ACTIVE_STATUSES` constant moved to `lib/types.ts`) in both the queue table and the document detail page. New `Spinner`/`PendingSubmitButton` components wired into every button that kicks off a background run (retry, approve, restore-furniture-line, proceed-anyway, delete, reprocess, hard reset) so a click gets immediate visual feedback instead of looking inert until the next poll. `tsc`/`next build` clean across all six routes, `next dev` smoke-tested (same expected credentials-missing 500s). | Pull, `npm install`, `npm run dev`. Check the new progress bar renders sensibly across every status and that each button shows its spinner immediately on click. Separately: reply with what furniture you'd expect flagged on the Enforcer V11 manual (or paste a couple of raw `work/<hash>/pages/*.md` files) so the detection question can actually get resolved instead of guessed at. |
| 2026-07-18 | Root-caused the furniture-detection and confusing-graph-labels feedback from the same session down to one bug: `chunk.py`'s `_is_heading()` heuristic (short, single-line, no trailing punctuation) also matches vision-transcribed `**Label:** value` bold field lines, e.g. `**Page Number:** 4`. Once misclassified as a heading, that text becomes `chunk.section` — and thus `/graph`'s node/neighbor labels — for every chunk after it, so many unrelated chunks on many different real pages all showed the same misleading label, and clicking a "related chunk" correctly jumped to genuinely different content that just had a lying label (the edges/click behavior were never broken). Also explains why furniture detection missed it without needing the raw-page sample asked for last session: a field whose value is stuck at a constant "4" would still only appear on the subset of pages that went through the vision path, likely too few of the full 46 to cross `FURNITURE_MIN_PAGE_RATIO`. Fixed with a `_FIELD_VALUE_LINE_RE` guard in `_is_heading()`; 2 new tests (78/78 pipeline-wide) confirming the field line doesn't become `section` and doesn't clobber a real preceding heading. Not verified against the real document — the fix only helps once the affected document's chunks are regenerated. | Pull, install, `pytest` (78 passed expected). Reprocess the Enforcer V11 document **from 'chunk'** (via the reprocess controls built earlier this session) and reopen `/graph` — confirm `**Page Number:** 4`-style labels are gone and clicking a related chunk now makes sense relative to its label. Paste any other garbage label pattern that survives, rather than guessing at a broader fix up front. |
| 2026-07-18 | Follow-up on the same real document: `/graph` also showing `**Table of Contents**` as the label for many unrelated real pages (not the actual TOC page), with high similarity scores between them. Same underlying bug class as the `**Page Number:** 4` fix earlier this session (`chunk.py`'s `_is_heading()` is too permissive), but a different literal phrase — the field-value regex didn't cover it since "Table of Contents" isn't a `Label: value` line. Generalized instead of special-casing another string: `chunk_pages` now runs a document-local pass (`_find_repeated_heading_texts`) that excludes any heading-shaped line repeating on 3+ distinct pages from ever being classified as a real heading, on the reasoning that a genuine section title is page-specific and essentially never repeats verbatim, while a much lower bar than clean.py's furniture threshold is worth it here since the failure mode of over-excluding is cheap (content is kept either way, only the `section` label falls back to the prior real heading). Also finally answers the original furniture-detection question from two sessions back without the raw-page sample that was asked for: a hallucinated phrase repeated only across the vision-processed subset of pages plausibly never reaches the furniture detector's ~30%-of-whole-document bar either. 5 new tests (83/83 pipeline-wide). Not verified against the real document — the same reprocess-from-'chunk' step covers both this and the earlier field-value fix. | Pull, install, `pytest` (83 passed expected). Reprocess the Enforcer V11 document from 'chunk' and reopen `/graph` — confirm both known garbage-label patterns are gone. If a third one shows up, paste it rather than have me guess at a broader rule. Also worth a gut check on whether 3 repeats is too aggressive once more real, larger manuals are loaded (a legitimately-reused heading text would lose its `section` label past that point) — it's a single constant to tune if so. |
| 2026-07-18 | Asked about auto-discovering/scraping manuals from the internet given re-downloading/re-uploading each one by hand is tedious. Discussed rather than building it immediately: full autonomous scraping has real problems (matching the right manual/revision from search results is error-prone and could silently pollute the corpus with wrong documents, most manufacturer sites have no API so it'd mean fragile per-site scrapers, and bulk-automated downloading sits in a legal/ToS gray area even though a human clicking the same download link is normal) — laid out three tiers (bulk folder drop / ingest-by-URL / guided discovery-with-human-approval) and asked which to build first. Picked bulk folder drop. Built on `main` (sandbox still has no real Supabase/NIM): new `corpus ingest-dir <dir> [--process]` CLI command (one-shot bulk ingest of every PDF in a folder, `--process` to also run the full pipeline per document, one bad PDF doesn't abort the batch); review-ui's upload form now accepts multiple files at once, single-file UX unchanged, multi-file redirects to the queue with an ingested/duplicate/failed summary banner. First CLI-level test file (`test_cli.py`, 5 tests via `CliRunner` + monkeypatching) — 88/88 pipeline-wide. `tsc`/`next build` clean. Not run against real data — needs a real folder of PDFs and a real multi-file browser upload to verify. | Pull, install, `pytest` (88 passed expected), `npm run dev`. Try `corpus ingest-dir` against a real folder of manuals, and try a real multi-file browser upload including one deliberately-bad file to confirm the failure handling. Ingest-by-URL and guided discovery are still on the table if bulk drop isn't enough on its own. |
| 2026-07-18 | Asked for a real upload progress bar (the spinner alone didn't show how much had transferred). Root problem: uploads went through a Server Action, which only exposes a pending/not-pending boolean — real byte-progress needs `XMLHttpRequest.upload.onprogress`, which needs an actual client-controlled endpoint. Moved upload off `app/actions.ts` onto a new `POST /api/documents/upload` Route Handler (same rationale as the reprocess/reset routes), moved the shared `ingestOne`/`startProcessing` helpers into `lib/pipeline.ts`, and rewrote `UploadForm` as a self-contained client component driving a hand-rolled XHR-based upload with a real percentage bar, transitioning to an indeterminate "Finalizing…" state once byte transfer completes but the server's still hashing/inserting. Single- and multi-file redirect behavior preserved, just client-initiated now. Deleted the old `uploadDocument` server action outright and removed the `next.config.ts` `serverActions.bodySizeLimit` override that existed only for it (Route Handlers have no equivalent cap here). `tsc`/`next build` clean across all seven routes; `next dev` smoke-tested (empty POST 400s, a real multipart POST reaches the expected missing-pipeline-env error) — no real browser/XHR or pipeline env available to verify the actual progress-bar behavior in this sandbox. | Pull, `npm install`, `npm run dev`. Upload a real multi-MB manual and actually watch the bar move end to end (0→100%→Finalizing→redirect), try a multi-file batch too, and re-run the duplicate/bad-file/single-file-redirect checks from last session since the whole upload path was rewired, not just the bar layered on top. |
| 2026-07-19 | Added the cleaning stage per a fully-specified task (furniture stripping, structural page/chunk tagging, runt handling, >15% safety rail, Cleaning tab, furniture-detector unit tests) — one genuine gap in the spec: the repeated-safety-warning test case referenced "(see note below)" with no note attached. Asked and got a clear answer: add a keyword exception (`warning`/`caution`/`danger`/`note:`), never auto-strip that content regardless of repetition, given this is a fire/security panel corpus. Built `clean.py` (new), updated `chunk.py` (reads cleaned pages, runt handling, structural metadata), `cli.py` (`_process` gains a clean step + early-stop on the safety rail, new `restore-furniture` command), `db.py` (`delete_chunks`), a new migration (`documents.metadata` column, graph/search RPCs updated to respect the new exclusion rule), and the review UI's new Cleaning tab. Found and fixed two real logic bugs before they shipped (not caught by the spec, caught by testing): `apply_runt_handling` initially couldn't cascade-merge multiple consecutive runts (excluded already-runt-tagged chunks as merge targets, not just structural ones); `clean_pages` initially flattened cleaned lines with a single join, silently destroying the paragraph boundaries `chunk.py`'s splitting depends on. Also worked through several of my own test-fixture bugs (templated "page N" body text registering as furniture itself) before the real test suite was trustworthy. 65/65 pipeline tests passing (14 new for `clean.py`, 10 new for runt handling), 3 hand-built end-to-end scenarios verified via monkeypatched DB (safety rail correctly passes on realistic content, correctly trips and blocks chunk/embed on sparse content, `proceed_override` correctly unsticks it), `tsc`/`next build` clean across all four routes. Nothing verified against real Supabase/NIM/manuals — same sandbox constraint as every session. | Pull, reinstall (no new deps either side), apply the new migration, `pytest` (expect 65 passed). Run a real manual through and actually judge the heuristic against real content: does furniture.json look right, does a real TOC page get tagged, does a repeated real safety warning survive, is 15% the right safety-rail threshold. Try restoring a furniture line and toggling a structural/runt chunk's retrieval inclusion for real. Then back to loading the rest of the corpus (M6). |

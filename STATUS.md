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
├── supabase/
│   ├── config.toml        ← links this repo to the Supabase project (GitHub integration)
│   └── migrations/        ← schema migrations, auto-applied on push to main
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
  5. Once that looks right, M4 is done. M5 (review UI) is next — no NIM
     model needed for that, just Next.js talking to the same Supabase.

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

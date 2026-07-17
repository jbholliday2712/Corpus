-- Corpus ingestion pipeline schema.
-- Apply to the Supabase project via the SQL editor or `psql "$DATABASE_URL" -f db/schema.sql`.
--
-- IMPORTANT: the `embedding` column dimension below (1024) matches
-- nvidia/nv-embedqa-e5-v5. If a different NIM embedding model is used,
-- confirm its output dimension (run `corpus check` after configuring .env)
-- and edit the `vector(N)` size before applying.

create extension if not exists vector;
create extension if not exists pgcrypto; -- gen_random_uuid()

create table if not exists documents (
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
  metadata_confirmed boolean default false,  -- true after metadata is approved in review UI
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create table if not exists chunks (
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

create index if not exists chunks_embedding_hnsw on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_content_fts on chunks using gin (to_tsvector('english', content));
create index if not exists chunks_document_id_idx on chunks (document_id);

-- Records which embedding model produced the vectors currently in `chunks`.
-- The future chat app reads this to know which model to embed queries with.
create table if not exists settings (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz default now()
);

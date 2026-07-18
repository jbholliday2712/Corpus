-- Supports the cleaning stage (STATUS.md §4 Stage 1.5): furniture
-- stripping, structural page/chunk tagging, runt handling, and the >15%
-- stripped safety rail.

-- documents.metadata mirrors chunks.metadata (already jsonb from the
-- initial schema) — holds non-fatal, structured flags that don't belong in
-- error_message (documented there as "populated when status = failed"),
-- e.g. {"cleaning_warning": {...}} when the safety rail trips, or
-- {"proceed_override": true} when a human clicks "proceed anyway" in the
-- review UI's Cleaning tab.
alter table documents add column if not exists metadata jsonb default '{}';

-- Structural (TOC/index/revision-history) and runt (<50 token, no
-- same-section neighbour to merge into) chunks are tagged
-- chunks.metadata->>'section_type' by chunk.py and MUST be excluded from
-- similarity search — see STATUS.md §9. review-ui's graph/search features
-- are an explicit preview of that future retrieval behaviour, so the same
-- exclusion is applied here too, with an escape hatch: a chunk with
-- metadata->>'retrieval_override' = 'true' (set via the Cleaning tab's
-- "include in retrieval" toggle) is never excluded regardless of
-- section_type.
create or replace function chunk_similarity_edges(
  similarity_threshold double precision default 0.75,
  max_neighbors int default 5
)
returns table (
  chunk_id uuid,
  neighbor_id uuid,
  similarity double precision
)
language sql
stable
as $$
  select
    c.id as chunk_id,
    neighbor.id as neighbor_id,
    1 - (c.embedding <=> neighbor.embedding) as similarity
  from chunks c
  join lateral (
    select ch.id, ch.embedding
    from chunks ch
    where ch.id <> c.id
      and ch.embedding is not null
      and (
        ch.metadata->>'section_type' is null
        or ch.metadata->>'retrieval_override' = 'true'
      )
    order by c.embedding <=> ch.embedding
    limit max_neighbors
  ) as neighbor on true
  where c.embedding is not null
    and (
      c.metadata->>'section_type' is null
      or c.metadata->>'retrieval_override' = 'true'
    )
    and 1 - (c.embedding <=> neighbor.embedding) >= similarity_threshold;
$$;

create or replace function search_chunks(
  query_embedding vector(1024),
  match_count int default 40
)
returns table (
  chunk_id uuid,
  similarity double precision
)
language sql
stable
as $$
  select
    id as chunk_id,
    1 - (embedding <=> query_embedding) as similarity
  from chunks
  where embedding is not null
    and (
      metadata->>'section_type' is null
      or metadata->>'retrieval_override' = 'true'
    )
  order by embedding <=> query_embedding
  limit match_count;
$$;

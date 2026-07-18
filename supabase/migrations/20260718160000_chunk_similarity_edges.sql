-- Powers the review-ui "graph" view (chunk-level semantic similarity, à la
-- Obsidian's note graph). For every chunk, finds its nearest neighbours by
-- embedding cosine similarity using the existing HNSW index
-- (chunks_embedding_hnsw from the initial schema) rather than a full
-- pairwise O(n^2) scan, so this stays cheap as the corpus grows.
--
-- Returns directed edges (chunk_id -> neighbor_id); review-ui dedupes the
-- A-B/B-A pair client-side since similarity is symmetric.
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
    order by c.embedding <=> ch.embedding
    limit max_neighbors
  ) as neighbor on true
  where c.embedding is not null
    and 1 - (c.embedding <=> neighbor.embedding) >= similarity_threshold;
$$;

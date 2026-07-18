-- Top-K vector search over chunks, using the same HNSW index as
-- chunk_similarity_edges. Powers review-ui's "search-and-highlight" graph
-- feature (embed the query with `corpus embed-query`, pass the vector here)
-- and doubles as a preview of the retrieval the future RAG chat app will do
-- at query time — same operator, same index.
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
  order by embedding <=> query_embedding
  limit match_count;
$$;

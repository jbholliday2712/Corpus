import { getSupabaseAdmin } from "@/lib/supabase";
import { GraphCanvas, type GraphLink, type GraphNode } from "@/components/GraphCanvas";

export const dynamic = "force-dynamic";

// Edges come from supabase/migrations/..._chunk_similarity_edges.sql, which
// walks the HNSW index for each chunk's top-N neighbours rather than a full
// pairwise scan, so this stays cheap as the corpus grows.
const SIMILARITY_THRESHOLD = 0.78;
const MAX_NEIGHBORS = 5;

interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  section: string | null;
  page_start: number | null;
  content: string;
}

interface EdgeRow {
  chunk_id: string;
  neighbor_id: string;
  similarity: number;
}

// Golden-angle hue rotation gives well-separated colors for an unknown
// number of documents without needing a fixed palette.
function colorForIndex(i: number): string {
  const hue = (i * 137.508) % 360;
  return `hsl(${hue.toFixed(0)}, 65%, 50%)`;
}

export default async function GraphPage() {
  const supabase = getSupabaseAdmin();

  const { data: documents, error: docsError } = await supabase
    .from("documents")
    .select("id, file_name")
    .order("created_at", { ascending: true });

  const { data: chunks, error: chunksError } = await supabase
    .from("chunks")
    .select("id, document_id, chunk_index, section, page_start, content")
    .not("embedding", "is", null)
    .returns<ChunkRow[]>();

  const { data: edgeRowsRaw, error: edgesError } = await supabase.rpc(
    "chunk_similarity_edges",
    {
      similarity_threshold: SIMILARITY_THRESHOLD,
      max_neighbors: MAX_NEIGHBORS,
    }
  );
  const edgeRows = edgeRowsRaw as EdgeRow[] | null;

  const error = docsError ?? chunksError ?? edgesError;
  if (error) {
    return (
      <main className="mx-auto max-w-6xl px-8 py-8">
        <p className="text-red-600">Failed to load graph data: {error.message}</p>
        {edgesError && (
          <p className="mt-2 text-sm text-gray-500">
            If this is a missing-function error, the{" "}
            <code>chunk_similarity_edges</code> migration hasn&apos;t been
            applied to this Supabase project yet.
          </p>
        )}
      </main>
    );
  }

  const docList = documents ?? [];
  const docColor = new Map<string, string>();
  const docName = new Map<string, string>();
  docList.forEach((d, i) => {
    docColor.set(d.id, colorForIndex(i));
    docName.set(d.id, d.file_name);
  });

  const nodes: GraphNode[] = (chunks ?? []).map((c) => ({
    id: c.id,
    documentId: c.document_id,
    documentName: docName.get(c.document_id) ?? "?",
    label: c.section
      ? `${c.section} (p.${c.page_start ?? "?"})`
      : `#${c.chunk_index} (p.${c.page_start ?? "?"}) — ${c.content.slice(0, 60)}`,
    color: docColor.get(c.document_id) ?? "#888888",
  }));

  const seenPairs = new Set<string>();
  const links: GraphLink[] = [];
  for (const row of edgeRows ?? []) {
    const [a, b] = [row.chunk_id, row.neighbor_id].sort();
    const key = `${a}|${b}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    links.push({ source: row.chunk_id, target: row.neighbor_id, similarity: row.similarity });
  }

  return (
    <main className="mx-auto max-w-6xl px-8 py-8">
      <h1 className="mb-2 text-2xl font-semibold text-gray-900">Chunk Graph</h1>
      <p className="mb-4 text-sm text-gray-600">
        {nodes.length} embedded chunks across {docList.length} document
        {docList.length === 1 ? "" : "s"}. An edge means embedding cosine
        similarity &ge; {SIMILARITY_THRESHOLD} (top {MAX_NEIGHBORS} neighbours
        per chunk). Chunks with no close match appear unconnected — click any
        node to open it in its document.
      </p>

      {docList.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-x-4 gap-y-2 rounded-lg border border-gray-200 bg-white p-3 text-xs">
          {docList.map((d, i) => (
            <span key={d.id} className="flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: colorForIndex(i) }}
              />
              <span className="text-gray-700">{d.file_name}</span>
            </span>
          ))}
        </div>
      )}

      {nodes.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-gray-500">
          No embedded chunks yet — the graph fills in once documents finish
          processing.
        </p>
      ) : (
        <GraphCanvas nodes={nodes} links={links} />
      )}
    </main>
  );
}

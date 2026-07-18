"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState, useTransition } from "react";
import { searchChunks } from "@/app/actions";
import { connectedComponents } from "@/lib/clustering";
import { GraphCanvas, type GraphLink, type GraphNode } from "./GraphCanvas";
import { GraphPreviewPanel, type PreviewNeighbor, type PreviewNode } from "./GraphPreviewPanel";

export interface ExplorerChunk {
  id: string;
  documentId: string;
  documentName: string;
  chunkIndex: number;
  section: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  extractionPath: string | null;
  tokenCount: number | null;
}

export interface ExplorerDocument {
  id: string;
  fileName: string;
}

const MUTED_GRAY = "#cbd5e1";

// Golden-angle hue rotation gives well-separated colors for an unknown
// number of documents/clusters without needing a fixed palette.
function colorForIndex(i: number): string {
  const hue = (i * 137.508) % 360;
  return `hsl(${hue.toFixed(0)}, 65%, 50%)`;
}

function chunkLabel(c: ExplorerChunk): string {
  return c.section
    ? `${c.section} (p.${c.pageStart ?? "?"})`
    : `Chunk #${c.chunkIndex} (p.${c.pageStart ?? "?"})`;
}

export function GraphExplorer({
  chunks,
  documents,
  edges,
}: {
  chunks: ExplorerChunk[];
  documents: ExplorerDocument[];
  edges: GraphLink[];
}) {
  const router = useRouter();
  const [viewMode, setViewMode] = useState<"chunks" | "documents">("chunks");
  const [colorMode, setColorMode] = useState<"document" | "cluster">("document");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Map<string, number> | null>(null);
  const [isSearching, startSearch] = useTransition();
  const [searchError, setSearchError] = useState<string | null>(null);

  const docColor = useMemo(() => {
    const m = new Map<string, string>();
    documents.forEach((d, i) => m.set(d.id, colorForIndex(i)));
    return m;
  }, [documents]);

  const chunkById = useMemo(() => new Map(chunks.map((c) => [c.id, c])), [chunks]);

  const degree = useMemo(() => {
    const m = new Map<string, number>();
    edges.forEach((e) => {
      m.set(e.source, (m.get(e.source) ?? 0) + 1);
      m.set(e.target, (m.get(e.target) ?? 0) + 1);
    });
    return m;
  }, [edges]);

  const clusterOf = useMemo(
    () => connectedComponents(chunks.map((c) => c.id), edges),
    [chunks, edges]
  );

  const { clusterColor, clusterCount } = useMemo(() => {
    // Only clusters with 2+ members get a real color — with hundreds of
    // singleton/orphan chunks, giving every one a unique hue would just be
    // noise. Orphans fade to gray so the real groupings stand out.
    const sizes = new Map<number, number>();
    clusterOf.forEach((c) => sizes.set(c, (sizes.get(c) ?? 0) + 1));
    const realClusters = [...sizes.entries()].filter(([, size]) => size >= 2).map(([c]) => c);
    const colorMap = new Map<number, string>();
    realClusters.forEach((c, i) => colorMap.set(c, colorForIndex(i)));
    return { clusterColor: colorMap, clusterCount: realClusters.length };
  }, [clusterOf]);

  const chunkGraph = useMemo<{ nodes: GraphNode[]; links: GraphLink[] }>(() => {
    const nodes: GraphNode[] = chunks.map((c) => {
      const cluster = clusterOf.get(c.id);
      const color =
        colorMode === "cluster"
          ? (cluster !== undefined ? clusterColor.get(cluster) : undefined) ?? MUTED_GRAY
          : (docColor.get(c.documentId) ?? MUTED_GRAY);
      return {
        id: c.id,
        documentId: c.documentId,
        documentName: c.documentName,
        label: chunkLabel(c),
        color,
        val: Math.max(1, degree.get(c.id) ?? 0),
      };
    });
    return { nodes, links: edges };
  }, [chunks, edges, colorMode, docColor, clusterOf, clusterColor, degree]);

  const documentGraph = useMemo<{ nodes: GraphNode[]; links: GraphLink[] }>(() => {
    const pairStats = new Map<string, { count: number; sum: number }>();
    for (const e of edges) {
      const da = chunkById.get(e.source)?.documentId;
      const db = chunkById.get(e.target)?.documentId;
      if (!da || !db || da === db) continue;
      const [a, b] = [da, db].sort();
      const key = `${a}|${b}`;
      const s = pairStats.get(key) ?? { count: 0, sum: 0 };
      s.count += 1;
      s.sum += e.similarity;
      pairStats.set(key, s);
    }
    const nodes: GraphNode[] = documents.map((d, i) => ({
      id: d.id,
      documentId: d.id,
      documentName: d.fileName,
      label: d.fileName,
      color: colorForIndex(i),
      val: 4,
    }));
    const links: GraphLink[] = [];
    pairStats.forEach((s, key) => {
      const [a, b] = key.split("|");
      links.push({ source: a, target: b, similarity: s.sum / s.count, count: s.count });
    });
    return { nodes, links };
  }, [documents, edges, chunkById]);

  const activeGraph = viewMode === "chunks" ? chunkGraph : documentGraph;

  const highlighted = useMemo(() => {
    if (!matches) return undefined;
    return new Set(matches.keys());
  }, [matches]);

  function handleNodeClick(id: string) {
    if (viewMode === "documents") {
      router.push(`/documents/${id}`);
      return;
    }
    setSelectedId(id);
  }

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) {
      setMatches(null);
      return;
    }
    setSearchError(null);
    startSearch(async () => {
      try {
        const results = await searchChunks(q);
        setMatches(new Map(results.map((r) => [r.chunkId, r.similarity])));
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : "Search failed.");
      }
    });
  }

  function clearSearch() {
    setMatches(null);
    setQuery("");
    setSearchError(null);
  }

  const selectedChunk = selectedId ? (chunkById.get(selectedId) ?? null) : null;
  const previewNode: PreviewNode | null = selectedChunk
    ? {
        id: selectedChunk.id,
        documentId: selectedChunk.documentId,
        documentName: selectedChunk.documentName,
        section: selectedChunk.section,
        pageStart: selectedChunk.pageStart,
        pageEnd: selectedChunk.pageEnd,
        extractionPath: selectedChunk.extractionPath,
        tokenCount: selectedChunk.tokenCount,
      }
    : null;

  const neighbors: PreviewNeighbor[] = selectedId
    ? edges
        .filter((e) => e.source === selectedId || e.target === selectedId)
        .map((e) => {
          const otherId = e.source === selectedId ? e.target : e.source;
          const other = chunkById.get(otherId);
          return {
            id: otherId,
            similarity: e.similarity,
            label: other ? chunkLabel(other) : otherId,
          };
        })
    : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-3">
        <form onSubmit={handleSearch} className="flex min-w-[240px] flex-1 items-center gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Search the corpus… e.g. "zone wiring"'
            className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
          />
          <button
            type="submit"
            disabled={isSearching}
            className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isSearching ? "Searching…" : "Search"}
          </button>
          {matches && (
            <button
              type="button"
              onClick={clearSearch}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Clear
            </button>
          )}
        </form>

        <div className="flex items-center gap-1 rounded border border-gray-300 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setViewMode("chunks")}
            className={`rounded px-2 py-1 ${viewMode === "chunks" ? "bg-gray-900 text-white" : "text-gray-600"}`}
          >
            Chunks
          </button>
          <button
            type="button"
            onClick={() => setViewMode("documents")}
            className={`rounded px-2 py-1 ${viewMode === "documents" ? "bg-gray-900 text-white" : "text-gray-600"}`}
          >
            Documents
          </button>
        </div>

        {viewMode === "chunks" && (
          <div className="flex items-center gap-1 rounded border border-gray-300 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setColorMode("document")}
              className={`rounded px-2 py-1 ${colorMode === "document" ? "bg-gray-900 text-white" : "text-gray-600"}`}
            >
              Color: document
            </button>
            <button
              type="button"
              onClick={() => setColorMode("cluster")}
              className={`rounded px-2 py-1 ${colorMode === "cluster" ? "bg-gray-900 text-white" : "text-gray-600"}`}
            >
              Color: cluster
            </button>
          </div>
        )}
      </div>

      {searchError && <p className="text-sm text-red-600">{searchError}</p>}
      {matches && (
        <p className="text-sm text-gray-600">
          {matches.size} chunk{matches.size === 1 ? "" : "s"} matched — highlighted below,
          ranked by similarity to your query.
        </p>
      )}
      {colorMode === "cluster" && viewMode === "chunks" && (
        <p className="text-xs text-gray-500">
          {clusterCount} cluster{clusterCount === 1 ? "" : "s"} of 2+ transitively-linked
          chunks found (gray nodes have no close match at the current threshold).
        </p>
      )}

      <div className="flex h-[75vh] gap-4">
        <div className="flex-1">
          <GraphCanvas
            nodes={activeGraph.nodes}
            links={activeGraph.links}
            highlightedIds={highlighted}
            onNodeClick={handleNodeClick}
          />
        </div>
        {viewMode === "chunks" && (
          <div className="w-80 shrink-0 rounded-lg border border-gray-200 bg-white shadow-sm">
            <GraphPreviewPanel
              node={previewNode}
              neighbors={neighbors}
              onSelectNeighbor={setSelectedId}
              onClose={() => setSelectedId(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { getChunkContent } from "@/app/actions";

export interface PreviewNode {
  id: string;
  documentId: string;
  documentName: string;
  section: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  extractionPath: string | null;
  tokenCount: number | null;
}

export interface PreviewNeighbor {
  id: string;
  label: string;
  similarity: number;
}

export function GraphPreviewPanel({
  node,
  neighbors,
  onSelectNeighbor,
  onClose,
}: {
  node: PreviewNode | null;
  neighbors: PreviewNeighbor[];
  onSelectNeighbor: (id: string) => void;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!node) {
      setContent(null);
      return;
    }
    setContent(null);
    // Content is fetched on demand (not shipped for every node up front) so
    // the initial graph payload stays small as the corpus grows.
    startTransition(async () => {
      const c = await getChunkContent(node.id);
      setContent(c);
    });
  }, [node]);

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-gray-400">
        Click a node to preview its content here.
      </div>
    );
  }

  const pageLabel =
    node.pageStart != null
      ? `p.${node.pageStart}${node.pageEnd != null && node.pageEnd !== node.pageStart ? `–${node.pageEnd}` : ""}`
      : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-2 border-b border-gray-200 p-4">
        <div className="min-w-0">
          <div className="truncate text-xs text-gray-500">{node.documentName}</div>
          <div className="truncate text-sm font-medium text-gray-900">
            {node.section ?? "Chunk"} {pageLabel && <span className="font-normal text-gray-500">· {pageLabel}</span>}
          </div>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 text-gray-400 hover:text-gray-600"
          aria-label="Close preview"
        >
          &times;
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-3 flex flex-wrap gap-3 text-xs text-gray-500">
          <span
            className={node.extractionPath === "vision" ? "font-medium text-purple-700" : ""}
          >
            {node.extractionPath ?? "text"}
          </span>
          <span>{node.tokenCount ?? "?"} tokens</span>
        </div>
        {isPending || content === null ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-sm text-gray-800">
            {content}
          </pre>
        )}
      </div>

      {neighbors.length > 0 && (
        <div className="max-h-64 overflow-y-auto border-t border-gray-200 p-4">
          <div className="mb-2 text-xs font-medium tracking-wide text-gray-500 uppercase">
            Related chunks
          </div>
          <ul className="flex flex-col gap-1">
            {neighbors
              .slice()
              .sort((a, b) => b.similarity - a.similarity)
              .map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => onSelectNeighbor(n.id)}
                    className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-gray-50"
                  >
                    <span className="truncate text-gray-700">{n.label}</span>
                    <span className="shrink-0 text-gray-400">
                      {(n.similarity * 100).toFixed(0)}%
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}

      <div className="border-t border-gray-200 p-4">
        <Link
          href={`/documents/${node.documentId}#chunk-${node.id}`}
          className="text-sm text-blue-700 hover:underline"
        >
          Open in document &rarr;
        </Link>
      </div>
    </div>
  );
}

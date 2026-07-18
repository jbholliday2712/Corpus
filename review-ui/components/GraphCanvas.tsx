"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
});

export interface GraphNode {
  id: string;
  documentId: string;
  documentName: string;
  label: string;
  color: string;
  /** Relative size hint, e.g. degree in the current edge set. Defaults to 1. */
  val?: number;
}

export interface GraphLink {
  source: string;
  target: string;
  similarity: number;
  /** Document-level view only: how many chunk pairs this edge aggregates. */
  count?: number;
}

const FADED_NODE_COLOR = "rgba(203, 213, 225, 0.45)";
const FADED_LINK_COLOR = "rgba(100, 116, 139, 0.06)";
const HIGHLIGHT_LINK_COLOR = "rgba(37, 99, 235, 0.55)";
const DEFAULT_LINK_COLOR = "rgba(100, 116, 139, 0.35)";

function endpointId(endpoint: GraphLink["source"] | { id?: string }): string {
  return typeof endpoint === "string" ? endpoint : ((endpoint as { id?: string }).id ?? "");
}

export function GraphCanvas({
  nodes,
  links,
  highlightedIds,
  onNodeClick,
}: {
  nodes: GraphNode[];
  links: GraphLink[];
  /** When set (even to an empty Set from a zero-result search), non-matching
   * nodes/links fade out so matches pop — Obsidian-style search highlight. */
  highlightedIds?: Set<string>;
  onNodeClick?: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

  useEffect(() => {
    function updateSize() {
      if (!containerRef.current) return;
      setSize({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
    }
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  // react-force-graph mutates the objects it's given (adds x/y/vx/vy) — copy
  // so re-renders from fresh server data don't fight the running simulation.
  const graphData = useMemo(
    () => ({
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    }),
    [nodes, links]
  );

  const isFiltering = Boolean(highlightedIds && highlightedIds.size > 0);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden rounded-lg border border-gray-200 bg-white"
    >
      <ForceGraph2D
        graphData={graphData}
        width={size.width}
        height={size.height}
        nodeId="id"
        nodeLabel={(node: unknown) => {
          const n = node as GraphNode;
          return `${n.documentName}\n${n.label}`;
        }}
        nodeColor={(node: unknown) => {
          const n = node as GraphNode;
          if (isFiltering) {
            return highlightedIds!.has(n.id) ? n.color : FADED_NODE_COLOR;
          }
          return n.color;
        }}
        nodeVal={(node: unknown) => {
          const n = node as GraphNode;
          const base = n.val ?? 1;
          if (isFiltering) {
            return highlightedIds!.has(n.id) ? base + 3 : Math.max(0.5, base * 0.4);
          }
          return base;
        }}
        nodeRelSize={4}
        linkColor={(link: unknown) => {
          const l = link as GraphLink;
          if (isFiltering) {
            const touches =
              highlightedIds!.has(endpointId(l.source)) ||
              highlightedIds!.has(endpointId(l.target));
            return touches ? HIGHLIGHT_LINK_COLOR : FADED_LINK_COLOR;
          }
          return DEFAULT_LINK_COLOR;
        }}
        linkWidth={(link: unknown) => {
          const l = link as GraphLink;
          return Math.max(0.5, (l.similarity - 0.7) * 8);
        }}
        onNodeClick={(node: unknown) => {
          const n = node as GraphNode;
          onNodeClick?.(n.id);
        }}
        cooldownTicks={150}
      />
    </div>
  );
}

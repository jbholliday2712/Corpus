"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
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
}

export interface GraphLink {
  source: string;
  target: string;
  similarity: number;
}

export function GraphCanvas({
  nodes,
  links,
}: {
  nodes: GraphNode[];
  links: GraphLink[];
}) {
  const router = useRouter();
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

  return (
    <div
      ref={containerRef}
      className="h-[75vh] w-full overflow-hidden rounded-lg border border-gray-200 bg-white"
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <ForceGraph2D
        graphData={graphData}
        width={size.width}
        height={size.height}
        nodeId="id"
        nodeLabel={(node: unknown) => {
          const n = node as GraphNode;
          return `${n.documentName}\n${n.label}`;
        }}
        nodeColor={(node: unknown) => (node as GraphNode).color}
        nodeRelSize={4}
        linkColor={() => "rgba(100, 116, 139, 0.35)"}
        linkWidth={(link: unknown) => {
          const l = link as GraphLink;
          return Math.max(0.5, (l.similarity - 0.7) * 8);
        }}
        onNodeClick={(node: unknown) => {
          const n = node as GraphNode;
          router.push(`/documents/${n.documentId}#chunk-${n.id}`);
        }}
        cooldownTicks={150}
      />
    </div>
  );
}

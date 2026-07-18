import type { DocStatus } from "@/lib/types";

const COLORS: Record<DocStatus, string> = {
  queued: "bg-gray-200 text-gray-800",
  extracting: "bg-blue-100 text-blue-800",
  chunking: "bg-blue-100 text-blue-800",
  embedding: "bg-blue-100 text-blue-800",
  review: "bg-amber-100 text-amber-800",
  done: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

// Statuses where the pipeline is actively working on the document — used
// both for the pulsing dot below and to decide when pages should poll for
// updates (see components/AutoRefresh.tsx).
export const ACTIVE_STATUSES: DocStatus[] = [
  "queued",
  "extracting",
  "chunking",
  "embedding",
];

export function StatusBadge({ status }: { status: DocStatus }) {
  const isActive = ACTIVE_STATUSES.includes(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium ${COLORS[status] ?? "bg-gray-100 text-gray-800"}`}
    >
      {isActive && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-500 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue-600" />
        </span>
      )}
      {status}
    </span>
  );
}

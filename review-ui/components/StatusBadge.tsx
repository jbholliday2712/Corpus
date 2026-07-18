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

export function StatusBadge({ status }: { status: DocStatus }) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${COLORS[status] ?? "bg-gray-100 text-gray-800"}`}
    >
      {status}
    </span>
  );
}

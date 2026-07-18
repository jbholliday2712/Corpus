import type { DocStatus } from "@/lib/types";

/**
 * Visualizes where a document sits in the extract -> clean -> chunk ->
 * embed -> review pipeline as a segmented bar, so "something is running"
 * is visible at a glance instead of only a status word. This is shared by
 * every path that moves a document through these statuses — initial
 * processing, `corpus retry`, and reprocess-from-any-stage all just update
 * `documents.status`, so this one component (driven by DocumentTable's 3s
 * poll or a server render) covers all of them without knowing which
 * triggered it. Cleaning has no dedicated status (see STATUS.md §4), so
 * it's folded into the "Clean & chunk" segment alongside chunking.
 */
const STEPS: { key: DocStatus; label: string }[] = [
  { key: "queued", label: "Queued" },
  { key: "extracting", label: "Extract" },
  { key: "chunking", label: "Clean & chunk" },
  { key: "embedding", label: "Embed" },
  { key: "review", label: "Review" },
];

const STEP_INDEX: Partial<Record<DocStatus, number>> = {
  queued: 0,
  extracting: 1,
  chunking: 2,
  embedding: 3,
  review: 4,
  done: 4,
};

export function StageProgress({ status }: { status: DocStatus }) {
  if (status === "failed") {
    return (
      <div className="flex items-center gap-1.5 text-xs font-medium text-red-700">
        <span className="h-1.5 w-1.5 rounded-full bg-red-600" />
        Failed
      </div>
    );
  }

  const currentIndex = STEP_INDEX[status] ?? 0;
  const isDone = status === "done";

  return (
    <div className="flex w-full min-w-[140px] flex-col gap-1">
      <div className="flex gap-0.5" role="progressbar" aria-label={`Pipeline stage: ${status}`}>
        {STEPS.map((step, i) => {
          const completed = isDone || i < currentIndex;
          const active = !isDone && i === currentIndex;
          return (
            <div
              key={step.key}
              title={step.label}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                completed
                  ? "bg-emerald-500"
                  : active
                    ? "animate-pulse bg-blue-500"
                    : "bg-gray-200"
              }`}
            />
          );
        })}
      </div>
      <span className="text-[11px] text-gray-500">
        {isDone ? "Done" : (STEPS[currentIndex]?.label ?? status)}
      </span>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DocStatus } from "@/lib/types";
import { IN_PROGRESS_STATUSES } from "@/lib/types";

type Stage = "clean" | "chunk" | "embed";

const STAGE_LABELS: Record<Stage, string> = {
  clean: "From cleaning",
  chunk: "From chunking",
  embed: "From embedding",
};

// Reprocessing from 'clean' or 'chunk' deletes and rebuilds the chunk rows
// (see pipeline/corpus/reprocess.py), which loses any chunk-level
// retrieval_override toggles set in the review UI. 'embed' keeps the
// existing chunk rows and only clears their embedding, so toggles survive —
// no warning needed for that option.
const STAGES_THAT_LOSE_CHUNK_TOGGLES: Stage[] = ["clean", "chunk"];

export function ReprocessControls({
  documentId,
  fileName,
  status,
  hasManualChunkToggles,
}: {
  documentId: string;
  fileName: string;
  status: DocStatus;
  hasManualChunkToggles: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<"reprocess" | "overflow" | null>(null);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(null);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const disabled = busy || IN_PROGRESS_STATUSES.includes(status);

  async function runReprocess(fromStage: Stage) {
    setOpen(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/documents/${documentId}/reprocess`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromStage }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        alert(body.error ?? `Reprocess request failed (${res.status}).`);
      } else {
        router.refresh();
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Reprocess request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runReset() {
    setOpen(null);
    const confirmed = confirm(
      `Hard reset ${fileName}?\n\n` +
        "This permanently deletes:\n" +
        "  • the document row\n" +
        "  • all of its chunks\n" +
        "  • its extracted pages (work/<hash>/)\n" +
        "  • its stored PDF (store/<hash>.pdf)\n\n" +
        "To reprocess it afterward, you will need to re-drop the PDF into inbox/."
    );
    if (!confirmed) return;

    setBusy(true);
    try {
      const res = await fetch(`/api/documents/${documentId}/reset`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        alert(body.error ?? `Reset request failed (${res.status}).`);
      } else {
        router.refresh();
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Reset request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={containerRef} className="flex items-center gap-1">
      <div className="relative inline-flex">
        <button
          type="button"
          disabled={disabled}
          onClick={() => runReprocess("clean")}
          className="rounded-l bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reprocess
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(open === "reprocess" ? null : "reprocess")}
          className="rounded-r border-l border-blue-500 bg-blue-600 px-1.5 py-1 text-xs text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Reprocess from a different stage"
        >
          &#9662;
        </button>
        {open === "reprocess" && (
          <div className="absolute left-0 top-full z-10 mt-1 w-56 rounded border border-gray-200 bg-white py-1 shadow-lg">
            {(Object.keys(STAGE_LABELS) as Stage[]).map((stage) => (
              <button
                key={stage}
                type="button"
                onClick={() => runReprocess(stage)}
                className="block w-full px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50"
              >
                {STAGE_LABELS[stage]}
                {hasManualChunkToggles && STAGES_THAT_LOSE_CHUNK_TOGGLES.includes(stage) && (
                  <div className="mt-0.5 text-[11px] text-amber-700">
                    Loses manual chunk include/exclude toggles
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative inline-flex">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(open === "overflow" ? null : "overflow")}
          className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="More actions"
        >
          &#8942;
        </button>
        {open === "overflow" && (
          <div className="absolute right-0 top-full z-10 mt-1 w-36 rounded border border-gray-200 bg-white py-1 shadow-lg">
            <button
              type="button"
              onClick={runReset}
              className="block w-full px-3 py-1.5 text-left text-xs text-red-700 hover:bg-red-50"
            >
              Hard reset
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { DocStatus, DocumentRow } from "@/lib/types";
import type { DocumentFlag } from "@/lib/flags";
import { deleteDocument, retryDocument } from "@/app/actions";
import { MetadataForm } from "@/components/MetadataForm";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { PendingSubmitButton } from "@/components/PendingSubmitButton";
import { ReprocessControls } from "@/components/ReprocessControls";
import { StageProgress } from "@/components/StageProgress";

const POLL_INTERVAL_MS = 3000;

interface LiveStatus {
  status: DocStatus;
  error_message: string | null;
}

/**
 * Polls the lightweight /api/documents endpoint so status changes (e.g. a
 * reprocess run moving a document through chunking -> embedding -> review)
 * show up without a full page reload. Deliberately separate from
 * AutoRefresh's router.refresh(): that re-renders the whole server
 * component (metadata forms, flags, chunk counts) every tick, which would
 * blow away in-progress form input; this only ever touches the status
 * badge and error text for rows already on the page.
 */
function useLiveStatuses(): Map<string, LiveStatus> {
  const [live, setLive] = useState<Map<string, LiveStatus>>(new Map());

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/documents");
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { documents: (LiveStatus & { id: string })[] };
        if (cancelled) return;
        setLive(new Map(body.documents.map((d) => [d.id, d])));
      } catch {
        // Transient fetch failure — keep showing the last known status
        // rather than clearing it; the next tick will retry.
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return live;
}

function FlagBadge({ flags }: { flags: DocumentFlag[] }) {
  if (flags.length === 0) {
    return <span className="text-xs text-gray-300">—</span>;
  }
  const hasCritical = flags.some((f) => f.severity === "critical");
  const tooltip = flags.map((f) => `• ${f.label}`).join("\n");
  return (
    <span
      title={tooltip}
      className={`inline-flex cursor-help items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${
        hasCritical ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"
      }`}
    >
      ⚠ {flags.length}
    </span>
  );
}

export function DocumentTable({
  docs,
  chunkCounts,
  flagsByDoc,
  manualChunkToggles,
}: {
  docs: DocumentRow[];
  chunkCounts: Map<string, number>;
  flagsByDoc: Map<string, DocumentFlag[]>;
  manualChunkToggles: Map<string, boolean>;
}) {
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const liveStatuses = useLiveStatuses();

  const flaggedCount = useMemo(
    () => docs.filter((d) => (flagsByDoc.get(d.id)?.length ?? 0) > 0).length,
    [docs, flagsByDoc]
  );

  const visibleDocs = flaggedOnly
    ? docs.filter((d) => (flagsByDoc.get(d.id)?.length ?? 0) > 0)
    : docs;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={flaggedOnly}
            onChange={(e) => setFlaggedOnly(e.target.checked)}
            className="rounded border-gray-300"
          />
          Flagged only
        </label>
        <span className="text-xs text-gray-500">
          {flaggedCount} of {docs.length} document{docs.length === 1 ? "" : "s"} flagged for a
          second look
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="w-full min-w-[960px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium tracking-wide text-gray-500 uppercase">
              <th className="px-4 py-3">File</th>
              <th className="px-4 py-3">Metadata</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Chunks</th>
              <th className="px-4 py-3">Flags</th>
              <th className="px-4 py-3">Error</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleDocs.map((doc) => {
              const live = liveStatuses.get(doc.id);
              const status = live?.status ?? doc.status;
              const errorMessage = live?.error_message ?? doc.error_message;
              return (
                <tr
                  key={doc.id}
                  className="border-b border-gray-100 align-top last:border-b-0 hover:bg-gray-50"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/documents/${doc.id}`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {doc.file_name}
                    </Link>
                    <div className="text-xs text-gray-500">{doc.page_count ?? "?"} pages</div>
                  </td>
                  <td className="px-4 py-3">
                    <MetadataForm doc={doc} />
                  </td>
                  <td className="px-4 py-3">
                    <StageProgress status={status} />
                    {doc.metadata_confirmed && (
                      <div className="mt-1 text-xs text-green-700">metadata confirmed</div>
                    )}
                  </td>
                  <td className="px-4 py-3">{chunkCounts.get(doc.id) ?? 0}</td>
                  <td className="px-4 py-3">
                    <FlagBadge flags={flagsByDoc.get(doc.id) ?? []} />
                  </td>
                  <td className="max-w-xs px-4 py-3 whitespace-pre-wrap text-red-700">
                    {errorMessage ?? ""}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-2">
                      {status === "failed" && (
                        <form action={retryDocument}>
                          <input type="hidden" name="id" value={doc.id} />
                          <PendingSubmitButton
                            label="Retry"
                            pendingLabel="Starting…"
                            className="rounded bg-amber-600 px-2 py-1 text-xs text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                          />
                        </form>
                      )}
                      <ReprocessControls
                        documentId={doc.id}
                        fileName={doc.file_name}
                        status={status}
                        hasManualChunkToggles={manualChunkToggles.get(doc.id) ?? false}
                      />
                      <form action={deleteDocument}>
                        <input type="hidden" name="id" value={doc.id} />
                        <ConfirmSubmitButton
                          label="Delete"
                          pendingLabel="Deleting…"
                          confirmText={`Delete ${doc.file_name}? This also deletes its chunks.`}
                          className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                        />
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
            {visibleDocs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-gray-400">
                  No flagged documents.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

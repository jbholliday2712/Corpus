"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { DocumentRow } from "@/lib/types";
import type { DocumentFlag } from "@/lib/flags";
import { deleteDocument, retryDocument } from "@/app/actions";
import { StatusBadge } from "@/components/StatusBadge";
import { MetadataForm } from "@/components/MetadataForm";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";

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
}: {
  docs: DocumentRow[];
  chunkCounts: Map<string, number>;
  flagsByDoc: Map<string, DocumentFlag[]>;
}) {
  const [flaggedOnly, setFlaggedOnly] = useState(false);

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
            {visibleDocs.map((doc) => (
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
                  <StatusBadge status={doc.status} />
                  {doc.metadata_confirmed && (
                    <div className="mt-1 text-xs text-green-700">metadata confirmed</div>
                  )}
                </td>
                <td className="px-4 py-3">{chunkCounts.get(doc.id) ?? 0}</td>
                <td className="px-4 py-3">
                  <FlagBadge flags={flagsByDoc.get(doc.id) ?? []} />
                </td>
                <td className="max-w-xs px-4 py-3 whitespace-pre-wrap text-red-700">
                  {doc.error_message ?? ""}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-col items-start gap-2">
                    {doc.status === "failed" && (
                      <form action={retryDocument}>
                        <input type="hidden" name="id" value={doc.id} />
                        <button
                          type="submit"
                          className="rounded bg-amber-600 px-2 py-1 text-xs text-white hover:bg-amber-700"
                        >
                          Retry
                        </button>
                      </form>
                    )}
                    <form action={deleteDocument}>
                      <input type="hidden" name="id" value={doc.id} />
                      <ConfirmSubmitButton
                        label="Delete"
                        confirmText={`Delete ${doc.file_name}? This also deletes its chunks.`}
                        className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700"
                      />
                    </form>
                  </div>
                </td>
              </tr>
            ))}
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

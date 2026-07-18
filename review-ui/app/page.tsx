import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { DocumentRow } from "@/lib/types";
import { deleteDocument, retryDocument, uploadDocument } from "./actions";
import { ACTIVE_STATUSES, StatusBadge } from "@/components/StatusBadge";
import { MetadataForm } from "@/components/MetadataForm";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { UploadForm } from "@/components/UploadForm";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ retrying?: string }>;
}) {
  const { retrying } = await searchParams;
  const supabase = getSupabaseAdmin();

  const { data: documents, error } = await supabase
    .from("documents")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <main className="mx-auto max-w-6xl px-8 py-8">
        <p className="text-red-600">Failed to load documents: {error.message}</p>
      </main>
    );
  }

  const docs = (documents ?? []) as DocumentRow[];
  const hasActiveDocument = docs.some((d) => ACTIVE_STATUSES.includes(d.status));

  const { data: chunkDocIds } = await supabase.from("chunks").select("document_id");
  const chunkCounts = new Map<string, number>();
  for (const row of chunkDocIds ?? []) {
    const docId = (row as { document_id: string }).document_id;
    chunkCounts.set(docId, (chunkCounts.get(docId) ?? 0) + 1);
  }

  return (
    <main className="mx-auto max-w-6xl px-8 py-8">
      {hasActiveDocument && <AutoRefresh />}

      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Document Queue</h1>
        <span className="text-sm text-gray-500">
          {docs.length} document{docs.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <UploadForm action={uploadDocument} />
      </div>

      {retrying && (
        <p className="mb-4 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">
          Retry started for document {retrying}. This page updates
          automatically once it finishes.
        </p>
      )}

      {docs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-gray-500">
          No documents yet. Upload a PDF above, or drop one in{" "}
          <code>inbox/</code> and run <code>corpus watch</code>.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                <th className="px-4 py-3">File</th>
                <th className="px-4 py-3">Metadata</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Chunks</th>
                <th className="px-4 py-3">Error</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id} className="border-b border-gray-100 align-top last:border-b-0 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/documents/${doc.id}`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {doc.file_name}
                    </Link>
                    <div className="text-xs text-gray-500">
                      {doc.page_count ?? "?"} pages
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <MetadataForm doc={doc} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={doc.status} />
                    {doc.metadata_confirmed && (
                      <div className="mt-1 text-xs text-green-700">
                        metadata confirmed
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">{chunkCounts.get(doc.id) ?? 0}</td>
                  <td className="max-w-xs whitespace-pre-wrap px-4 py-3 text-red-700">
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
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

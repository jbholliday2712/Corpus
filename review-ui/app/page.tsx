import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { DocumentRow } from "@/lib/types";
import { deleteDocument, retryDocument, uploadDocument } from "./actions";
import { StatusBadge } from "@/components/StatusBadge";
import { MetadataForm } from "@/components/MetadataForm";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { UploadForm } from "@/components/UploadForm";

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
      <main className="mx-auto max-w-6xl p-8">
        <p className="text-red-600">Failed to load documents: {error.message}</p>
      </main>
    );
  }

  const docs = (documents ?? []) as DocumentRow[];

  const { data: chunkDocIds } = await supabase.from("chunks").select("document_id");
  const chunkCounts = new Map<string, number>();
  for (const row of chunkDocIds ?? []) {
    const docId = (row as { document_id: string }).document_id;
    chunkCounts.set(docId, (chunkCounts.get(docId) ?? 0) + 1);
  }

  return (
    <main className="mx-auto max-w-6xl p-8">
      <h1 className="mb-6 text-2xl font-semibold">Corpus — Document Queue</h1>

      <UploadForm action={uploadDocument} />

      {retrying && (
        <p className="mb-4 rounded bg-blue-50 px-3 py-2 text-sm text-blue-800">
          Retry started for document {retrying}. It runs in the background —
          reload this page in a bit to see the updated status.
        </p>
      )}

      {docs.length === 0 ? (
        <p className="text-gray-500">
          No documents yet. Upload a PDF above, or drop one in{" "}
          <code>inbox/</code> and run <code>corpus watch</code>.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-2 pr-4">File</th>
                <th className="py-2 pr-4">Metadata</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Chunks</th>
                <th className="py-2 pr-4">Error</th>
                <th className="py-2 pr-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id} className="border-b align-top">
                  <td className="py-2 pr-4">
                    <Link
                      href={`/documents/${doc.id}`}
                      className="text-blue-700 hover:underline"
                    >
                      {doc.file_name}
                    </Link>
                    <div className="text-xs text-gray-500">
                      {doc.page_count ?? "?"} pages
                    </div>
                  </td>
                  <td className="py-2 pr-4">
                    <MetadataForm doc={doc} />
                  </td>
                  <td className="py-2 pr-4">
                    <StatusBadge status={doc.status} />
                    {doc.metadata_confirmed && (
                      <div className="mt-1 text-xs text-green-700">
                        metadata confirmed
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-4">{chunkCounts.get(doc.id) ?? 0}</td>
                  <td className="max-w-xs whitespace-pre-wrap py-2 pr-4 text-red-700">
                    {doc.error_message ?? ""}
                  </td>
                  <td className="py-2 pr-4">
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

import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { ChunkRow, DocumentRow } from "@/lib/types";
import { approveDocument } from "@/app/actions";
import { StatusBadge } from "@/components/StatusBadge";

export const dynamic = "force-dynamic";

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = getSupabaseAdmin();

  const { data: doc, error: docError } = await supabase
    .from("documents")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (docError) {
    return (
      <main className="mx-auto max-w-4xl p-8">
        <p className="text-red-600">Failed to load document: {docError.message}</p>
      </main>
    );
  }
  if (!doc) notFound();
  const typedDoc = doc as DocumentRow;

  const { data: chunks, error: chunksError } = await supabase
    .from("chunks")
    .select("*")
    .eq("document_id", id)
    .order("chunk_index", { ascending: true });
  const typedChunks = (chunks ?? []) as ChunkRow[];

  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/" className="text-sm text-blue-700 hover:underline">
        &larr; Back to queue
      </Link>

      <h1 className="mt-2 mb-1 text-2xl font-semibold">{typedDoc.file_name}</h1>
      <p className="mb-6 flex flex-wrap items-center gap-2 text-sm text-gray-600">
        <span>{typedDoc.manufacturer ?? "?"}</span>
        <span>&middot;</span>
        <span>{typedDoc.panel_model ?? "?"}</span>
        <span>&middot;</span>
        <span>{typedDoc.doc_type ?? "?"}</span>
        <span>&middot;</span>
        <span>rev {typedDoc.revision ?? "?"}</span>
        <span>&middot;</span>
        <StatusBadge status={typedDoc.status} />
        <span>&middot;</span>
        <span>{typedChunks.length} chunks</span>
      </p>

      {typedDoc.error_message && (
        <p className="mb-6 whitespace-pre-wrap rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {typedDoc.error_message}
        </p>
      )}

      {typedDoc.status === "review" && (
        <form action={approveDocument} className="mb-8">
          <input type="hidden" name="id" value={typedDoc.id} />
          <button
            type="submit"
            className="rounded bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700"
          >
            Approve &rarr; done
          </button>
        </form>
      )}
      {typedDoc.status === "done" && (
        <p className="mb-8 inline-block rounded bg-green-100 px-3 py-1.5 text-sm text-green-800">
          Approved — live for the chat app.
        </p>
      )}

      {chunksError && (
        <p className="text-red-600">Failed to load chunks: {chunksError.message}</p>
      )}

      <div className="flex flex-col gap-6">
        {typedChunks.map((chunk) => (
          <article key={chunk.id} className="rounded border p-4">
            <div className="mb-2 flex flex-wrap gap-3 text-xs text-gray-500">
              <span>#{chunk.chunk_index}</span>
              <span>
                pages {chunk.page_start ?? "?"}&ndash;{chunk.page_end ?? "?"}
              </span>
              {chunk.section && <span>section: {chunk.section}</span>}
              <span
                className={
                  chunk.extraction_path === "vision" ? "font-medium text-purple-700" : ""
                }
              >
                {chunk.extraction_path ?? "text"}
              </span>
              <span>{chunk.token_count ?? "?"} tokens</span>
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-sm">
              {chunk.content}
            </pre>
          </article>
        ))}
        {typedChunks.length === 0 && (
          <p className="text-gray-500">No chunks yet.</p>
        )}
      </div>
    </main>
  );
}

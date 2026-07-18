import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { ChunkRow, DocumentRow } from "@/lib/types";
import { approveDocument } from "@/app/actions";
import { ACTIVE_STATUSES, StatusBadge } from "@/components/StatusBadge";
import { AutoRefresh } from "@/components/AutoRefresh";
import { computeDocumentFlags, isChunkFlagged } from "@/lib/flags";

export const dynamic = "force-dynamic";

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ uploaded?: string; duplicate?: string }>;
}) {
  const { id } = await params;
  const { uploaded, duplicate } = await searchParams;
  const supabase = getSupabaseAdmin();

  const { data: doc, error: docError } = await supabase
    .from("documents")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (docError) {
    return (
      <main className="mx-auto max-w-4xl px-8 py-8">
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

  const flags = computeDocumentFlags(
    {
      pageCount: typedDoc.page_count,
      status: typedDoc.status,
      manufacturer: typedDoc.manufacturer,
      revision: typedDoc.revision,
      docType: typedDoc.doc_type,
    },
    typedChunks.map((c) => ({ tokenCount: c.token_count, extractionPath: c.extraction_path }))
  );

  return (
    <main className="mx-auto max-w-4xl px-8 py-8">
      {ACTIVE_STATUSES.includes(typedDoc.status) && <AutoRefresh />}

      <Link href="/" className="text-sm text-blue-700 hover:underline">
        &larr; Back to queue
      </Link>

      {uploaded && (
        <p className="mt-4 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">
          Uploaded. Processing (extract → metadata → chunk → embed) is
          running in the background — this page updates automatically.
        </p>
      )}
      {duplicate && (
        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          This file was already ingested (matching content hash) — showing
          the existing document instead of re-processing it.
        </p>
      )}

      <h1 className="mt-3 mb-2 text-2xl font-semibold text-gray-900">
        {typedDoc.file_name}
      </h1>
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
        <p className="mb-6 whitespace-pre-wrap rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {typedDoc.error_message}
        </p>
      )}

      {flags.length > 0 && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="mb-1 font-medium">Flagged for a second look:</div>
          <ul className="list-inside list-disc">
            {flags.map((f) => (
              <li key={f.key}>{f.label}</li>
            ))}
          </ul>
        </div>
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
        <p className="mb-8 inline-block rounded-lg bg-green-100 px-3 py-1.5 text-sm text-green-800">
          Approved — live for the chat app.
        </p>
      )}

      {chunksError && (
        <p className="text-red-600">Failed to load chunks: {chunksError.message}</p>
      )}

      <div className="flex flex-col gap-4">
        {typedChunks.map((chunk) => {
          const flagged = isChunkFlagged(chunk.token_count);
          return (
            <article
              key={chunk.id}
              id={`chunk-${chunk.id}`}
              className={`scroll-mt-4 rounded-lg border bg-white p-4 shadow-sm ${
                flagged ? "border-amber-300 ring-1 ring-amber-200" : "border-gray-200"
              }`}
            >
              <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-gray-500">
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
                {flagged && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">
                    ⚠ short chunk
                  </span>
                )}
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-sm">
                {chunk.content}
              </pre>
            </article>
          );
        })}
        {typedChunks.length === 0 && (
          <p className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-gray-500">
            No chunks yet.
          </p>
        )}
      </div>
    </main>
  );
}

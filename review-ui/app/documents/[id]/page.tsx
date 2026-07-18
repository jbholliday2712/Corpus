import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { ChunkRow, DocumentRow, FurnitureReport } from "@/lib/types";
import {
  approveDocument,
  getFurnitureReport,
  restoreFurnitureLine,
  setChunkRetrievalOverride,
  setProceedOverride,
} from "@/app/actions";
import { AutoRefresh } from "@/components/AutoRefresh";
import { PendingSubmitButton } from "@/components/PendingSubmitButton";
import { StageProgress } from "@/components/StageProgress";
import { computeDocumentFlags, isChunkFlagged } from "@/lib/flags";
import { ACTIVE_STATUSES } from "@/lib/types";

export const dynamic = "force-dynamic";

function sectionType(chunk: ChunkRow): string | null {
  return (chunk.metadata?.section_type as string | undefined) ?? null;
}

function isRetrievalOverridden(chunk: ChunkRow): boolean {
  return Boolean(chunk.metadata?.retrieval_override);
}

function tabLinkClass(active: boolean): string {
  return `border-b-2 px-3 py-2 text-sm font-medium ${
    active
      ? "border-blue-600 text-blue-700"
      : "border-transparent text-gray-500 hover:text-gray-700"
  }`;
}

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    uploaded?: string;
    duplicate?: string;
    tab?: string;
    restoring?: string;
  }>;
}) {
  const { id } = await params;
  const { uploaded, duplicate, tab, restoring } = await searchParams;
  const activeTab = tab === "cleaning" ? "cleaning" : "chunks";
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

  const cleaningWarning = typedDoc.metadata?.cleaning_warning as
    | { stripped_pct: number; message: string }
    | undefined;
  const proceedOverride = Boolean(typedDoc.metadata?.proceed_override);

  const flags = computeDocumentFlags(
    {
      pageCount: typedDoc.page_count,
      status: typedDoc.status,
      manufacturer: typedDoc.manufacturer,
      revision: typedDoc.revision,
      docType: typedDoc.doc_type,
      cleaningWarning,
    },
    typedChunks.map((c) => ({
      tokenCount: c.token_count,
      extractionPath: c.extraction_path,
      sectionType: sectionType(c),
    }))
  );

  const excludedChunks = typedChunks.filter(
    (c) => sectionType(c) && !isRetrievalOverridden(c)
  );

  let furnitureReport: FurnitureReport | null = null;
  if (activeTab === "cleaning") {
    furnitureReport = await getFurnitureReport(typedDoc.file_hash);
  }

  return (
    <main className="mx-auto max-w-4xl px-8 py-8">
      {ACTIVE_STATUSES.includes(typedDoc.status) && <AutoRefresh />}

      <Link href="/" className="text-sm text-blue-700 hover:underline">
        &larr; Back to queue
      </Link>

      {uploaded && (
        <p className="mt-4 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">
          Uploaded. Processing (extract → metadata → clean → chunk → embed) is
          running in the background — this page updates automatically.
        </p>
      )}
      {duplicate && (
        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          This file was already ingested (matching content hash) — showing
          the existing document instead of re-processing it.
        </p>
      )}
      {restoring && (
        <p className="mt-4 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">
          Running in the background — this page updates automatically once
          it finishes.
        </p>
      )}

      <h1 className="mt-3 mb-2 text-2xl font-semibold text-gray-900">
        {typedDoc.file_name}
      </h1>
      <p className="mb-3 flex flex-wrap items-center gap-2 text-sm text-gray-600">
        <span>{typedDoc.manufacturer ?? "?"}</span>
        <span>&middot;</span>
        <span>{typedDoc.panel_model ?? "?"}</span>
        <span>&middot;</span>
        <span>{typedDoc.doc_type ?? "?"}</span>
        <span>&middot;</span>
        <span>rev {typedDoc.revision ?? "?"}</span>
        <span>&middot;</span>
        <span>{typedChunks.length} chunks</span>
      </p>

      <div className="mb-6 max-w-xs">
        <StageProgress status={typedDoc.status} />
      </div>

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
          <PendingSubmitButton
            label="Approve → done"
            pendingLabel="Approving…"
            className="rounded bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </form>
      )}
      {typedDoc.status === "done" && (
        <p className="mb-8 inline-block rounded-lg bg-green-100 px-3 py-1.5 text-sm text-green-800">
          Approved — live for the chat app.
        </p>
      )}

      <div className="mb-6 flex gap-1 border-b border-gray-200">
        <Link href={`/documents/${id}`} className={tabLinkClass(activeTab === "chunks")}>
          Chunks
        </Link>
        <Link
          href={`/documents/${id}?tab=cleaning`}
          className={tabLinkClass(activeTab === "cleaning")}
        >
          Cleaning
          {excludedChunks.length > 0 && (
            <span className="ml-1.5 rounded-full bg-gray-200 px-1.5 py-0.5 text-xs text-gray-700">
              {excludedChunks.length}
            </span>
          )}
        </Link>
      </div>

      {chunksError && (
        <p className="text-red-600">Failed to load chunks: {chunksError.message}</p>
      )}

      {activeTab === "chunks" ? (
        <div className="flex flex-col gap-4">
          {typedChunks.map((chunk) => {
            const flagged = isChunkFlagged(chunk.token_count);
            const type = sectionType(chunk);
            const excluded = Boolean(type) && !isRetrievalOverridden(chunk);
            return (
              <article
                key={chunk.id}
                id={`chunk-${chunk.id}`}
                className={`scroll-mt-4 rounded-lg border p-4 shadow-sm ${
                  excluded
                    ? "border-gray-200 bg-gray-50"
                    : flagged
                      ? "border-amber-300 bg-white ring-1 ring-amber-200"
                      : "border-gray-200 bg-white"
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
                  {flagged && !excluded && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">
                      ⚠ short chunk
                    </span>
                  )}
                  {type && (
                    <span className="rounded bg-gray-200 px-1.5 py-0.5 font-medium text-gray-700">
                      {type}
                      {!excluded && " (included)"}
                      {excluded && " — excluded from retrieval"}
                    </span>
                  )}
                </div>
                <pre
                  className={`whitespace-pre-wrap break-words font-mono text-sm ${
                    excluded ? "text-gray-500" : ""
                  }`}
                >
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
      ) : (
        <div className="flex flex-col gap-8">
          {cleaningWarning && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              <p className="mb-2 font-medium">Cleaning safety rail triggered</p>
              <p className="mb-3">{cleaningWarning.message}</p>
              {!proceedOverride && (
                <form action={setProceedOverride}>
                  <input type="hidden" name="id" value={typedDoc.id} />
                  <PendingSubmitButton
                    label="Proceed anyway (chunk & embed as cleaned)"
                    pendingLabel="Starting…"
                    className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </form>
              )}
              {proceedOverride && (
                <p className="text-xs text-red-700">
                  Proceed override is set — re-run <code>corpus retry</code> (or wait for
                  the background run this may have already triggered) to continue.
                </p>
              )}
            </div>
          )}

          <section>
            <h2 className="mb-2 text-lg font-semibold text-gray-900">
              Furniture stripped from this document
            </h2>
            {!furnitureReport ? (
              <p className="text-sm text-gray-500">
                No cleaning report yet — this document hasn&apos;t reached the cleaning
                stage.
              </p>
            ) : furnitureReport.furniture.length === 0 ? (
              <p className="text-sm text-gray-500">
                Nothing was stripped ({furnitureReport.total_lines} lines scanned across{" "}
                {furnitureReport.total_pages} pages).
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
                <p className="border-b border-gray-100 px-4 py-2 text-xs text-gray-500">
                  {furnitureReport.stripped_lines}/{furnitureReport.total_lines} lines
                  stripped ({furnitureReport.stripped_pct}%) — a line needed to repeat on
                  at least {furnitureReport.threshold_pages} pages to be flagged.
                </p>
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium tracking-wide text-gray-500 uppercase">
                      <th className="px-4 py-2">Line</th>
                      <th className="px-4 py-2">Pages</th>
                      <th className="px-4 py-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {furnitureReport.furniture.map((entry) => (
                      <tr key={entry.normalized} className="border-b border-gray-100 last:border-b-0">
                        <td className="px-4 py-2 font-mono text-xs text-gray-800">
                          {entry.example_lines[0] ?? entry.normalized}
                        </td>
                        <td className="px-4 py-2 text-xs text-gray-500">
                          {entry.page_count} pages (e.g. {entry.example_pages.join(", ")})
                        </td>
                        <td className="px-4 py-2">
                          <form action={restoreFurnitureLine}>
                            <input type="hidden" name="id" value={typedDoc.id} />
                            <input
                              type="hidden"
                              name="normalizedLine"
                              value={entry.normalized}
                            />
                            <PendingSubmitButton
                              label="Restore"
                              pendingLabel="Restoring…"
                              className="rounded bg-gray-700 px-2 py-1 text-xs text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                            />
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-gray-900">
              Structural &amp; runt chunks
            </h2>
            <p className="mb-3 text-sm text-gray-500">
              TOC/index/revision-history pages (structural) and near-empty
              chunks with no same-section neighbour to merge into (runt) are
              excluded from similarity search by default — not deleted.
              Toggle a chunk back in if that&apos;s wrong for this document.
            </p>
            {typedChunks.filter((c) => sectionType(c)).length === 0 ? (
              <p className="text-sm text-gray-500">
                No structural or runt chunks in this document.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {typedChunks
                  .filter((c) => sectionType(c))
                  .map((c) => {
                    const included = isRetrievalOverridden(c);
                    return (
                      <div
                        key={c.id}
                        className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3"
                      >
                        <div className="min-w-0">
                          <div className="mb-1 flex flex-wrap gap-2 text-xs text-gray-500">
                            <span>#{c.chunk_index}</span>
                            <span>
                              pages {c.page_start ?? "?"}&ndash;{c.page_end ?? "?"}
                            </span>
                            <span className="rounded bg-gray-200 px-1.5 py-0.5 font-medium text-gray-700">
                              {sectionType(c)}
                            </span>
                            {included && (
                              <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-800">
                                included in retrieval
                              </span>
                            )}
                          </div>
                          <p className="line-clamp-2 text-sm text-gray-600">{c.content}</p>
                        </div>
                        <form action={setChunkRetrievalOverride} className="shrink-0">
                          <input type="hidden" name="chunkId" value={c.id} />
                          <input type="hidden" name="documentId" value={typedDoc.id} />
                          <input
                            type="hidden"
                            name="include"
                            value={included ? "false" : "true"}
                          />
                          <button
                            type="submit"
                            className={`rounded px-2 py-1 text-xs font-medium ${
                              included
                                ? "bg-gray-200 text-gray-700 hover:bg-gray-300"
                                : "bg-emerald-600 text-white hover:bg-emerald-700"
                            }`}
                          >
                            {included ? "Exclude again" : "Include in retrieval"}
                          </button>
                        </form>
                      </div>
                    );
                  })}
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

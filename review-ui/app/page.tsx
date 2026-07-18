import { getSupabaseAdmin } from "@/lib/supabase";
import type { DocumentRow } from "@/lib/types";
import { UploadForm } from "@/components/UploadForm";
import { DocumentTable } from "@/components/DocumentTable";
import { computeDocumentFlags, type ChunkStat, type DocumentFlag } from "@/lib/flags";

export const dynamic = "force-dynamic";

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{
    retrying?: string;
    bulkUploaded?: string;
    bulkDuplicates?: string;
    bulkFailed?: string;
  }>;
}) {
  const { retrying, bulkUploaded, bulkDuplicates, bulkFailed } = await searchParams;
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

  // Lightweight per-chunk stats (no content) — enough to compute chunk
  // counts and the flagging heuristics in lib/flags.ts without shipping any
  // chunk text to this page.
  const { data: chunkRows } = await supabase
    .from("chunks")
    .select("document_id, token_count, extraction_path, metadata");

  const chunkCounts = new Map<string, number>();
  const chunksByDoc = new Map<string, ChunkStat[]>();
  const manualChunkToggles = new Map<string, boolean>();
  for (const row of (chunkRows ?? []) as {
    document_id: string;
    token_count: number | null;
    extraction_path: string | null;
    metadata: Record<string, unknown> | null;
  }[]) {
    chunkCounts.set(row.document_id, (chunkCounts.get(row.document_id) ?? 0) + 1);
    const stat: ChunkStat = {
      tokenCount: row.token_count,
      extractionPath: row.extraction_path,
      sectionType: (row.metadata?.section_type as string | undefined) ?? null,
    };
    const list = chunksByDoc.get(row.document_id);
    if (list) list.push(stat);
    else chunksByDoc.set(row.document_id, [stat]);

    // A human explicitly re-included this chunk via the Cleaning/Chunks tab
    // (see setChunkRetrievalOverride in app/actions.ts) — reprocessing from
    // 'clean' or 'chunk' deletes and recreates chunk rows, which loses this,
    // so ReprocessControls needs to know to warn about it per document.
    if (row.metadata?.retrieval_override) {
      manualChunkToggles.set(row.document_id, true);
    }
  }

  const flagsByDoc = new Map<string, DocumentFlag[]>();
  for (const doc of docs) {
    flagsByDoc.set(
      doc.id,
      computeDocumentFlags(
        {
          pageCount: doc.page_count,
          status: doc.status,
          manufacturer: doc.manufacturer,
          revision: doc.revision,
          docType: doc.doc_type,
          cleaningWarning: doc.metadata?.cleaning_warning as
            | { stripped_pct: number }
            | undefined,
        },
        chunksByDoc.get(doc.id) ?? []
      )
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Document Queue</h1>
        <span className="text-sm text-gray-500">
          {docs.length} document{docs.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <UploadForm />
      </div>

      {retrying && (
        <p className="mb-4 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">
          Retry started for document {retrying}. This page updates
          automatically once it finishes.
        </p>
      )}

      {bulkUploaded !== undefined && (
        <p className="mb-4 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">
          Bulk upload: {bulkUploaded} document{bulkUploaded === "1" ? "" : "s"} ingested
          and processing in the background
          {Number(bulkDuplicates) > 0 &&
            `, ${bulkDuplicates} duplicate${bulkDuplicates === "1" ? "" : "s"} skipped`}
          {Number(bulkFailed) > 0 &&
            `, ${bulkFailed} failed to ingest (see server logs)`}
          . This page updates automatically.
        </p>
      )}

      {docs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-gray-500">
          No documents yet. Upload a PDF above, or drop one in{" "}
          <code>inbox/</code> and run <code>corpus watch</code>.
        </p>
      ) : (
        <DocumentTable
          docs={docs}
          chunkCounts={chunkCounts}
          flagsByDoc={flagsByDoc}
          manualChunkToggles={manualChunkToggles}
        />
      )}
    </main>
  );
}

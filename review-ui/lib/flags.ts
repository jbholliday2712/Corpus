/**
 * Heuristic, cheap "worth a second look" flags — not a correctness
 * guarantee, a triage aid. The point is to let you open the 3 flagged
 * documents out of 40 instead of reading every chunk of every manual.
 * Thresholds are first-guess numbers, not tuned against a real corpus yet;
 * revisit them once there's more real data to judge false-positive/negative
 * rates against.
 */

export const MIN_CHUNK_TOKENS = 15;
const MIN_TOKENS_PER_PAGE = 40;
const HEAVY_VISION_RATIO = 0.5;
const PROSE_FIELD_MAX_CHARS = 40;

export interface ChunkStat {
  tokenCount: number | null;
  extractionPath: string | null;
  sectionType?: string | null;
}

export interface DocumentForFlagging {
  pageCount: number | null;
  status: string;
  manufacturer: string | null;
  revision: string | null;
  docType: string | null;
  cleaningWarning?: { stripped_pct: number } | null;
}

export interface DocumentFlag {
  key: string;
  severity: "warning" | "critical";
  label: string;
}

// The M4 finding was the LLM writing explanations into manufacturer/revision
// instead of a clean value or null (e.g. "Pyronix (implied, not explicitly
// stated but...)") — this targets that specific, already-observed failure
// mode, not prose in general.
function looksLikeProse(value: string | null): boolean {
  if (!value) return false;
  return value.length > PROSE_FIELD_MAX_CHARS || value.includes("(");
}

export function isChunkFlagged(tokenCount: number | null): boolean {
  return (tokenCount ?? 0) > 0 && (tokenCount ?? 0) < MIN_CHUNK_TOKENS;
}

export function computeDocumentFlags(
  doc: DocumentForFlagging,
  chunks: ChunkStat[]
): DocumentFlag[] {
  const flags: DocumentFlag[] = [];
  const isProcessed = doc.status === "review" || doc.status === "done";

  if (doc.cleaningWarning) {
    flags.push({
      key: "cleaning-safety-rail",
      severity: "critical",
      label: `${doc.cleaningWarning.stripped_pct}% of lines were stripped as furniture during cleaning — stopped before chunking/embedding, check the Cleaning tab.`,
    });
  }
  const chunkCount = chunks.length;
  const visionCount = chunks.filter((c) => c.extractionPath === "vision").length;
  const totalTokens = chunks.reduce((sum, c) => sum + (c.tokenCount ?? 0), 0);
  // Chunks already tagged structural/runt by the cleaning stage are handled
  // (visible, actionable in the Cleaning tab) — flagging them again here
  // would just be duplicate noise. Only count short chunks the pipeline
  // *didn't* already catch and tag.
  const shortChunkCount = chunks.filter(
    (c) => isChunkFlagged(c.tokenCount) && !c.sectionType
  ).length;

  if (isProcessed && (doc.pageCount ?? 0) > 0 && chunkCount === 0) {
    flags.push({
      key: "no-chunks",
      severity: "critical",
      label: "Finished processing with zero chunks — extraction likely produced nothing.",
    });
  }

  if (isProcessed && chunkCount > 0 && doc.pageCount) {
    const tokensPerPage = totalTokens / doc.pageCount;
    if (tokensPerPage < MIN_TOKENS_PER_PAGE) {
      flags.push({
        key: "low-content-density",
        severity: "warning",
        label: `Only ~${Math.round(tokensPerPage)} tokens/page on average — extraction may have missed most of the content.`,
      });
    }
  }

  if (shortChunkCount > 0) {
    flags.push({
      key: "short-chunks",
      severity: "warning",
      label: `${shortChunkCount} chunk${shortChunkCount === 1 ? "" : "s"} under ${MIN_CHUNK_TOKENS} tokens — possibly near-empty extraction.`,
    });
  }

  if (chunkCount > 0 && visionCount / chunkCount > HEAVY_VISION_RATIO) {
    flags.push({
      key: "heavily-vision",
      severity: "warning",
      label: `${visionCount}/${chunkCount} chunks are vision-derived — higher hallucination/repetition risk (STATUS.md M3).`,
    });
  }

  if (looksLikeProse(doc.manufacturer)) {
    flags.push({
      key: "manufacturer-prose",
      severity: "warning",
      label: "Manufacturer field looks like an explanation, not a clean value — check it.",
    });
  }
  if (looksLikeProse(doc.revision)) {
    flags.push({
      key: "revision-prose",
      severity: "warning",
      label: "Revision field looks like an explanation, not a clean value — check it.",
    });
  }

  if (isProcessed && !doc.docType) {
    flags.push({ key: "no-doc-type", severity: "warning", label: "No document type inferred." });
  }

  return flags;
}

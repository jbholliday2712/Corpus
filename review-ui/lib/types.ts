export type DocStatus =
  | "queued"
  | "extracting"
  | "chunking"
  | "embedding"
  | "review"
  | "done"
  | "failed";

// Statuses where a pipeline stage is actively running against this
// document right now — narrower than StatusBadge's ACTIVE_STATUSES (which
// also includes "queued", a document that hasn't started yet and is safe
// to reprocess/reset). Used to disable reprocess/reset controls and to
// reject those requests server-side while a background run owns the row.
export const IN_PROGRESS_STATUSES: DocStatus[] = ["extracting", "chunking", "embedding"];

export const DOC_TYPES = [
  "engineering_manual",
  "install_manual",
  "datasheet",
  "user_manual",
  "other",
] as const;

export interface DocumentRow {
  id: string;
  file_name: string;
  file_hash: string;
  manufacturer: string | null;
  panel_model: string | null;
  doc_type: string | null;
  revision: string | null;
  page_count: number | null;
  status: DocStatus;
  error_message: string | null;
  metadata_confirmed: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface CleaningWarning {
  stripped_pct: number;
  message: string;
}

export interface FurnitureEntry {
  normalized: string;
  page_count: number;
  example_pages: number[];
  example_lines: string[];
}

export interface FurnitureReport {
  total_pages: number;
  total_lines: number;
  stripped_lines: number;
  stripped_pct: number;
  threshold_pages: number;
  furniture: FurnitureEntry[];
}

export interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  page_start: number | null;
  page_end: number | null;
  section: string | null;
  extraction_path: string | null;
  token_count: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

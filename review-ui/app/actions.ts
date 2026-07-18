"use server";

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase";

const execFileAsync = promisify(execFile);

function formString(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function requirePipelineEnv(): { pythonBin: string; pipelineDir: string } {
  const pythonBin = process.env.CORPUS_PYTHON;
  const pipelineDir = process.env.CORPUS_PIPELINE_DIR;
  if (!pythonBin || !pipelineDir) {
    throw new Error(
      "CORPUS_PYTHON / CORPUS_PIPELINE_DIR are not set (see review-ui/.env.local.example)."
    );
  }
  return { pythonBin, pipelineDir: path.resolve(pipelineDir) };
}

// work/ is a sibling of pipeline/ per corpus/paths.py (ROOT/work,
// ROOT/pipeline) — no separate env var needed, just derive it.
function workDirFor(fileHash: string): string {
  const { pipelineDir } = requirePipelineEnv();
  return path.join(pipelineDir, "..", "work", fileHash);
}

export async function confirmMetadata(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("documents")
    .update({
      manufacturer: formString(formData, "manufacturer"),
      panel_model: formString(formData, "panel_model"),
      doc_type: formString(formData, "doc_type"),
      revision: formString(formData, "revision"),
      metadata_confirmed: true,
    })
    .eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/");
  revalidatePath(`/documents/${id}`);
}

export async function deleteDocument(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  const supabase = getSupabaseAdmin();
  // ON DELETE CASCADE on chunks.document_id (see supabase/migrations) takes
  // care of the chunk rows.
  const { error } = await supabase.from("documents").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/");
}

export async function approveDocument(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("documents")
    .update({ status: "done" })
    .eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/");
  revalidatePath(`/documents/${id}`);
}

export async function retryDocument(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  const { pythonBin, pipelineDir } = requirePipelineEnv();

  // `corpus retry` can take minutes on a vision-heavy document, and every
  // pipeline stage is independently resumable (see STATUS.md M4 notes), so
  // there's nothing worth awaiting here — fire it in the background and let
  // the queue view's status column catch up once it's done.
  const child = spawn(pythonBin, ["-m", "corpus.cli", "retry", id], {
    cwd: pipelineDir,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  redirect(`/?retrying=${id}`);
}

export async function uploadDocument(formData: FormData): Promise<void> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("No file selected.");
  }
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    throw new Error("Only .pdf files are accepted.");
  }

  const { pythonBin, pipelineDir } = requirePipelineEnv();

  // Stage the upload somewhere `corpus ingest` can read it from — it copies
  // into store/<hash>.pdf itself, so this is just a scratch location.
  const tmpPath = path.join(os.tmpdir(), `corpus-upload-${randomUUID()}.pdf`);
  await fs.writeFile(tmpPath, Buffer.from(await file.arrayBuffer()));

  let id: string;
  let duplicate: boolean;
  try {
    // Ingest (hash + DB insert) is fast — no NIM calls — so it's fine to
    // await directly, unlike the full pipeline below.
    const { stdout } = await execFileAsync(
      pythonBin,
      ["-m", "corpus.cli", "ingest", tmpPath, "--json"],
      { cwd: pipelineDir }
    );
    const parsed = JSON.parse(stdout.trim());
    id = parsed.id;
    duplicate = Boolean(parsed.duplicate);
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }

  if (!duplicate) {
    // Same background-and-forget pattern as retry — extract/metadata/chunk
    // /embed can take minutes on a vision-heavy manual.
    const child = spawn(pythonBin, ["-m", "corpus.cli", "process", id], {
      cwd: pipelineDir,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  revalidatePath("/");
  redirect(`/documents/${id}?${duplicate ? "duplicate" : "uploaded"}=1`);
}

export async function getChunkContent(chunkId: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("chunks")
    .select("content")
    .eq("id", chunkId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.content ?? "";
}

export async function searchChunks(
  query: string
): Promise<{ chunkId: string; similarity: number }[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const { pythonBin, pipelineDir } = requirePipelineEnv();

  // Embeds with the same provider/model the pipeline used to embed every
  // chunk (input_type="query", matching STATUS.md's "same embedding model
  // must be used at query time" rule) via the existing providers.py, rather
  // than duplicating a NIM call in TypeScript. `embed-query` always prints
  // JSON — unlike `ingest`, it has no --json flag (and no human-readable
  // mode to opt out of).
  const { stdout } = await execFileAsync(
    pythonBin,
    ["-m", "corpus.cli", "embed-query", trimmed],
    { cwd: pipelineDir }
  );
  const { embedding } = JSON.parse(stdout.trim()) as { embedding: number[] };

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("search_chunks", {
    query_embedding: embedding,
    match_count: 40,
  });
  if (error) throw new Error(error.message);

  return ((data ?? []) as { chunk_id: string; similarity: number }[]).map((row) => ({
    chunkId: row.chunk_id,
    similarity: row.similarity,
  }));
}

export async function getFurnitureReport(fileHash: string) {
  const reportPath = path.join(workDirFor(fileHash), "furniture.json");
  try {
    const raw = await fs.readFile(reportPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    // Not cleaned yet (document hasn't reached that stage), or CORPUS_PIPELINE_DIR
    // points somewhere without filesystem access to work/ — either way, the
    // Cleaning tab just shows "nothing to show yet" rather than erroring.
    return null;
  }
}

export async function restoreFurnitureLine(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  const normalizedLine = String(formData.get("normalizedLine"));
  const { pythonBin, pipelineDir } = requirePipelineEnv();

  // Changes what gets stripped, so this replaces existing chunks (see
  // corpus restore-furniture) — can take as long as a full re-process on a
  // vision-heavy document, so it's backgrounded like retry/upload.
  const child = spawn(
    pythonBin,
    ["-m", "corpus.cli", "restore-furniture", id, normalizedLine],
    { cwd: pipelineDir, detached: true, stdio: "ignore" }
  );
  child.unref();

  redirect(`/documents/${id}?tab=cleaning&restoring=1`);
}

export async function setProceedOverride(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  const supabase = getSupabaseAdmin();

  const { data: doc, error: fetchError } = await supabase
    .from("documents")
    .select("metadata")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);

  const { error } = await supabase
    .from("documents")
    .update({
      metadata: { ...(doc?.metadata ?? {}), proceed_override: true },
    })
    .eq("id", id);
  if (error) throw new Error(error.message);

  const { pythonBin, pipelineDir } = requirePipelineEnv();
  // The override alone doesn't chunk/embed anything — retry re-evaluates
  // the safety-rail decision (now passing) and continues the pipeline.
  const child = spawn(pythonBin, ["-m", "corpus.cli", "retry", id], {
    cwd: pipelineDir,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  redirect(`/documents/${id}?tab=cleaning&restoring=1`);
}

export async function setChunkRetrievalOverride(
  formData: FormData
): Promise<void> {
  const chunkId = String(formData.get("chunkId"));
  const documentId = String(formData.get("documentId"));
  const include = formData.get("include") === "true";
  const supabase = getSupabaseAdmin();

  const { data: chunkRow, error: fetchError } = await supabase
    .from("chunks")
    .select("metadata")
    .eq("id", chunkId)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);

  const nextMetadata = { ...(chunkRow?.metadata ?? {}) };
  if (include) {
    nextMetadata.retrieval_override = true;
  } else {
    delete nextMetadata.retrieval_override;
  }

  const { error } = await supabase
    .from("chunks")
    .update({ metadata: nextMetadata })
    .eq("id", chunkId);
  if (error) throw new Error(error.message);

  revalidatePath(`/documents/${documentId}`);
}

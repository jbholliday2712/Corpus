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

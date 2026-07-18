"use server";

import { spawn } from "node:child_process";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase";

function formString(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
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

  const pythonBin = process.env.CORPUS_PYTHON;
  const pipelineDir = process.env.CORPUS_PIPELINE_DIR;
  if (!pythonBin || !pipelineDir) {
    throw new Error(
      "CORPUS_PYTHON / CORPUS_PIPELINE_DIR are not set (see review-ui/.env.local.example)."
    );
  }

  // `corpus retry` can take minutes on a vision-heavy document, and every
  // pipeline stage is independently resumable (see STATUS.md M4 notes), so
  // there's nothing worth awaiting here — fire it in the background and let
  // the queue view's status column catch up once it's done.
  const child = spawn(pythonBin, ["-m", "corpus.cli", "retry", id], {
    cwd: path.resolve(pipelineDir),
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  redirect(`/?retrying=${id}`);
}

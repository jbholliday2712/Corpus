import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { requirePipelineEnv } from "@/lib/pipeline";
import { IN_PROGRESS_STATUSES } from "@/lib/types";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const supabase = getSupabaseAdmin();
  const { data: doc, error } = await supabase
    .from("documents")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!doc) {
    return NextResponse.json({ error: `No document ${id}` }, { status: 404 });
  }
  if (IN_PROGRESS_STATUSES.includes(doc.status)) {
    return NextResponse.json(
      { error: `Document is currently ${doc.status} — wait for it to finish.` },
      { status: 409 }
    );
  }

  const { pythonBin, pipelineDir } = requirePipelineEnv();

  // Fire-and-forget, same as reprocess — `corpus reset --hard` deletes the
  // DB row itself (cascading to chunks) and the on-disk work/store state,
  // so there is nothing left to poll for once it starts; the row simply
  // disappears from the next /api/documents poll.
  const child = spawn(pythonBin, ["-m", "corpus.cli", "reset", id, "--hard"], {
    cwd: pipelineDir,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return NextResponse.json({ ok: true, id }, { status: 202 });
}

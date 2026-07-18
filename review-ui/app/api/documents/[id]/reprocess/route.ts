import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { requirePipelineEnv } from "@/lib/pipeline";
import { IN_PROGRESS_STATUSES } from "@/lib/types";

const FROM_STAGES = ["clean", "chunk", "embed"] as const;
type FromStage = (typeof FROM_STAGES)[number];

function isFromStage(value: unknown): value is FromStage {
  return typeof value === "string" && (FROM_STAGES as readonly string[]).includes(value);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const fromStage = (body as { fromStage?: unknown } | null)?.fromStage;
  if (!isFromStage(fromStage)) {
    return NextResponse.json(
      { error: `fromStage must be one of: ${FROM_STAGES.join(", ")}` },
      { status: 400 }
    );
  }

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

  // Same fire-and-forget pattern as app/actions.ts's retry/restore-furniture:
  // reprocessing can take minutes on a vision-heavy document, and every
  // stage is independently resumable, so nothing here is worth awaiting —
  // the queue view's polling (GET /api/documents) picks up status changes
  // once the background process gets to them.
  const child = spawn(
    pythonBin,
    ["-m", "corpus.cli", "reprocess", id, "--from-stage", fromStage],
    { cwd: pipelineDir, detached: true, stdio: "ignore" }
  );
  child.unref();

  return NextResponse.json({ ok: true, id, fromStage }, { status: 202 });
}

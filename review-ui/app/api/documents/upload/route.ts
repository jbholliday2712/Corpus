import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { ingestOne, requirePipelineEnv, startProcessing } from "@/lib/pipeline";

interface UploadResult {
  fileName: string;
  id: string;
  duplicate: boolean;
}

interface UploadFailure {
  fileName: string;
  error: string;
}

/**
 * Real Route Handler (not a server action) specifically so the client can
 * drive this via XMLHttpRequest and get real upload-progress events —
 * `<form action={serverAction}>` gives no way to observe bytes-sent, only
 * a pending/not-pending boolean. See components/UploadForm.tsx.
 */
export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Request body must be multipart/form-data." }, { status: 400 });
  }

  const files = formData.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) {
    return NextResponse.json({ error: "No file selected." }, { status: 400 });
  }
  const nonPdf = files.find((f) => !f.name.toLowerCase().endsWith(".pdf"));
  if (nonPdf) {
    return NextResponse.json(
      { error: `Only .pdf files are accepted (got "${nonPdf.name}").` },
      { status: 400 }
    );
  }

  let pythonBin: string;
  let pipelineDir: string;
  try {
    ({ pythonBin, pipelineDir } = requirePipelineEnv());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Pipeline env not configured." },
      { status: 500 }
    );
  }

  const results: UploadResult[] = [];
  const failed: UploadFailure[] = [];

  // One bad PDF in the batch must not abort the rest — same per-file
  // failure handling `corpus watch`/`ingest-dir` already use.
  for (const file of files) {
    try {
      const { id, duplicate } = await ingestOne(file, pythonBin, pipelineDir);
      if (!duplicate) startProcessing(id, pythonBin, pipelineDir);
      results.push({ fileName: file.name, id, duplicate });
    } catch (err) {
      failed.push({
        fileName: file.name,
        error: err instanceof Error ? err.message : "Ingest failed.",
      });
    }
  }

  revalidatePath("/");

  const ingested = results.filter((r) => !r.duplicate).length;
  const duplicates = results.filter((r) => r.duplicate).length;

  return NextResponse.json({
    results,
    failed,
    ingested,
    duplicates,
    failedCount: failed.length,
  });
}

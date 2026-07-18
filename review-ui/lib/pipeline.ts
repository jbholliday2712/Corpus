import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Locates the Python venv / pipeline dir every child_process.spawn call
 * into corpus.cli needs (app/actions.ts's server actions, and the
 * app/api/documents/** route handlers). See review-ui/.env.local.example.
 */
export function requirePipelineEnv(): { pythonBin: string; pipelineDir: string } {
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
export function workDirFor(fileHash: string): string {
  const { pipelineDir } = requirePipelineEnv();
  return path.join(pipelineDir, "..", "work", fileHash);
}

/**
 * Ingest one already-uploaded File: hash + DB insert via `corpus ingest`.
 * Fast (no NIM calls), so callers can safely await it directly. Used by
 * app/api/documents/upload/route.ts, one call per file in the batch.
 */
export async function ingestOne(
  file: File,
  pythonBin: string,
  pipelineDir: string
): Promise<{ id: string; duplicate: boolean }> {
  // Stage the upload somewhere `corpus ingest` can read it from — it copies
  // into store/<hash>.pdf itself, so this is just a scratch location.
  const tmpPath = path.join(os.tmpdir(), `corpus-upload-${randomUUID()}.pdf`);
  await fs.writeFile(tmpPath, Buffer.from(await file.arrayBuffer()));
  try {
    const { stdout } = await execFileAsync(
      pythonBin,
      ["-m", "corpus.cli", "ingest", tmpPath, "--json"],
      { cwd: pipelineDir }
    );
    const parsed = JSON.parse(stdout.trim()) as { id: string; duplicate?: boolean };
    return { id: parsed.id, duplicate: Boolean(parsed.duplicate) };
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

/**
 * Kick off the full pipeline for a newly-ingested document, detached —
 * extract/metadata/clean/chunk/embed can take minutes on a vision-heavy
 * manual, and each document is its own process so one slow file in a bulk
 * upload doesn't hold up the others.
 */
export function startProcessing(id: string, pythonBin: string, pipelineDir: string): void {
  const child = spawn(pythonBin, ["-m", "corpus.cli", "process", id], {
    cwd: pipelineDir,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

import path from "node:path";

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

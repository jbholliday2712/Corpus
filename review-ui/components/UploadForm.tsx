"use client";

import { type FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";

interface UploadResult {
  fileName: string;
  id: string;
  duplicate: boolean;
}

interface UploadFailure {
  fileName: string;
  error: string;
}

interface UploadResponse {
  results: UploadResult[];
  failed: UploadFailure[];
  ingested: number;
  duplicates: number;
  failedCount: number;
}

/**
 * XMLHttpRequest, not fetch — fetch has no cross-browser way to observe
 * upload progress (only download/response streaming), while
 * `xhr.upload.onprogress` gives real bytes-sent/bytes-total events. Posts
 * to a real Route Handler (app/api/documents/upload) rather than a server
 * action for the same reason: `<form action={serverAction}>` only exposes
 * a pending/not-pending boolean via useFormStatus, nothing granular.
 */
function uploadWithProgress(
  files: File[],
  onProgress: (pct: number) => void
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    for (const file of files) formData.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/documents/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error(`Upload failed (${xhr.status}): invalid response.`));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as UploadResponse);
      } else {
        reject(new Error((body as { error?: string })?.error ?? `Upload failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.send(formData);
  });
}

export function UploadForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploading = progress !== null || finalizing;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const files = Array.from(inputRef.current?.files ?? []);
    if (files.length === 0) {
      setError("No file selected.");
      return;
    }

    setProgress(0);
    try {
      const response = await uploadWithProgress(files, (pct) => {
        setProgress(pct);
        // Byte transfer is done, but the server still has to hash + insert
        // each file (fast, but not instant) before it can respond.
        if (pct >= 100) setFinalizing(true);
      });

      if (files.length === 1) {
        const only = response.results[0];
        if (only) {
          router.push(`/documents/${only.id}?${only.duplicate ? "duplicate" : "uploaded"}=1`);
          return;
        }
        // The single file failed to ingest — surface it inline rather than
        // navigating away from a form with nothing to show for it.
        setProgress(null);
        setFinalizing(false);
        setError(response.failed[0]?.error ?? "Upload failed.");
        return;
      }

      router.push(
        `/?bulkUploaded=${response.ingested}&bulkDuplicates=${response.duplicates}&bulkFailed=${response.failedCount}`
      );
    } catch (err) {
      setProgress(null);
      setFinalizing(false);
      setError(err instanceof Error ? err.message : "Upload failed.");
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-6 flex flex-wrap items-center gap-3 rounded border border-dashed border-gray-300 p-4"
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        multiple
        required
        disabled={uploading}
        className="text-sm disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={uploading}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="inline-flex items-center gap-1.5">
          {uploading && <Spinner />}
          {uploading ? "Uploading…" : "Upload PDFs"}
        </span>
      </button>

      {uploading && (
        <div className="flex min-w-[160px] flex-1 items-center gap-2">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-200">
            <div
              className={`h-full rounded-full bg-blue-600 transition-[width] ${
                finalizing ? "animate-pulse" : ""
              }`}
              style={{ width: `${finalizing ? 100 : (progress ?? 0)}%` }}
            />
          </div>
          <span className="w-20 shrink-0 text-xs text-gray-500">
            {finalizing ? "Finalizing…" : `${progress}%`}
          </span>
        </div>
      )}

      {error && <p className="w-full text-xs text-red-600">{error}</p>}

      <span className="w-full text-xs text-gray-500">
        Select one PDF or many (ctrl/cmd-click, or select-all inside a
        folder) — each one is ingested and starts extract → metadata →
        clean → chunk → embed in the background. For bulk-loading a whole
        folder from the command line instead, see{" "}
        <code>corpus ingest-dir</code>.
      </span>
    </form>
  );
}

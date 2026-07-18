"use client";

import { useFormStatus } from "react-dom";
import { Spinner } from "@/components/Spinner";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="inline-flex items-center gap-1.5">
        {pending && <Spinner />}
        {pending ? "Uploading…" : "Upload PDFs"}
      </span>
    </button>
  );
}

export function UploadForm({
  action,
}: {
  action: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <form
      action={action}
      className="mb-6 flex flex-wrap items-center gap-3 rounded border border-dashed border-gray-300 p-4"
    >
      <input
        type="file"
        name="file"
        accept="application/pdf"
        multiple
        required
        className="text-sm"
      />
      <SubmitButton />
      <span className="text-xs text-gray-500">
        Select one PDF or many (ctrl/cmd-click, or select-all inside a
        folder) — each one is ingested and starts extract → metadata →
        clean → chunk → embed in the background. For bulk-loading a whole
        folder from the command line instead, see{" "}
        <code>corpus ingest-dir</code>.
      </span>
    </form>
  );
}

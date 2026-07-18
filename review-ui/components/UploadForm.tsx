"use client";

import { useFormStatus } from "react-dom";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
    >
      {pending ? "Uploading…" : "Upload PDF"}
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
        required
        className="text-sm"
      />
      <SubmitButton />
      <span className="text-xs text-gray-500">
        Ingests the PDF and starts extract → metadata → chunk → embed in the
        background.
      </span>
    </form>
  );
}

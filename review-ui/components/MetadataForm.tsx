import { DOC_TYPES, type DocumentRow } from "@/lib/types";
import { confirmMetadata } from "@/app/actions";

/**
 * Plain editable text inputs, not read-only display — metadata inference
 * sometimes writes explanatory prose into manufacturer/revision instead of
 * a clean value (see STATUS.md M4 notes), so review here always means
 * "look at this and fix it if it's wrong," not just "click confirm."
 */
export function MetadataForm({ doc }: { doc: DocumentRow }) {
  return (
    <form action={confirmMetadata} className="flex flex-col gap-1">
      <input type="hidden" name="id" value={doc.id} />
      <input
        name="manufacturer"
        defaultValue={doc.manufacturer ?? ""}
        placeholder="manufacturer"
        className="w-40 rounded border px-1 py-0.5 text-xs"
      />
      <input
        name="panel_model"
        defaultValue={doc.panel_model ?? ""}
        placeholder="panel model"
        className="w-40 rounded border px-1 py-0.5 text-xs"
      />
      <select
        name="doc_type"
        defaultValue={doc.doc_type ?? ""}
        className="w-40 rounded border px-1 py-0.5 text-xs"
      >
        <option value="">(none)</option>
        {DOC_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <input
        name="revision"
        defaultValue={doc.revision ?? ""}
        placeholder="revision"
        className="w-40 rounded border px-1 py-0.5 text-xs"
      />
      <button
        type="submit"
        className="mt-1 w-fit rounded bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-700"
      >
        {doc.metadata_confirmed ? "Update" : "Confirm"}
      </button>
    </form>
  );
}

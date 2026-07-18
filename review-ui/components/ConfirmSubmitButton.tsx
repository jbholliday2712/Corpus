"use client";

import { useFormStatus } from "react-dom";
import { Spinner } from "@/components/Spinner";

export function ConfirmSubmitButton({
  label,
  pendingLabel,
  confirmText,
  className,
}: {
  label: string;
  pendingLabel?: string;
  confirmText: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={className}
      onClick={(e) => {
        if (!confirm(confirmText)) e.preventDefault();
      }}
    >
      <span className="inline-flex items-center gap-1.5">
        {pending && <Spinner />}
        {pending ? (pendingLabel ?? label) : label}
      </span>
    </button>
  );
}

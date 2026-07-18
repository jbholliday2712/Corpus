"use client";

import { useFormStatus } from "react-dom";
import { Spinner } from "@/components/Spinner";

/**
 * Drop-in replacement for a plain `<button type="submit">` inside a form
 * that calls a backgrounding server action (retry, approve, restore-line,
 * ...). Shows a spinner for the brief window the action itself is running
 * (kicking off the detached background process, not the process finishing
 * — that's what StageProgress/live polling is for) so a click always gets
 * immediate visual feedback instead of looking like nothing happened.
 */
export function PendingSubmitButton({
  label,
  pendingLabel,
  className,
}: {
  label: string;
  pendingLabel?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className}>
      <span className="inline-flex items-center gap-1.5">
        {pending && <Spinner />}
        {pending ? (pendingLabel ?? label) : label}
      </span>
    </button>
  );
}

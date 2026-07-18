"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const POLL_INTERVAL_MS = 4000;

/**
 * Silently re-fetches the current route on an interval. Rendered only on
 * pages with at least one document mid-pipeline, so a status change (e.g.
 * extracting -> review) shows up without a manual reload.
 */
export function AutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [router]);
  return null;
}

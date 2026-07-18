import { createClient } from "@supabase/supabase-js";

/**
 * Server-only client using the service role key. This app is local-only
 * trusted tooling (see STATUS.md §1/§7) — never import this from a Client
 * Component, and never expose SUPABASE_SERVICE_KEY to the browser.
 */
export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_KEY are not set. Copy .env.local.example to .env.local and fill them in."
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

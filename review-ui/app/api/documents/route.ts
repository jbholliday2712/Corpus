import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

/**
 * Lightweight polling endpoint for DocumentTable's 3s status refresh — just
 * enough to update the status badge / spinner / error text on each row
 * without re-fetching (and re-rendering) everything page.tsx computes
 * server-side (metadata, chunk counts, flags). Full detail still comes from
 * the server-rendered page; this only exists to catch a status transition
 * a reprocess/reset run makes between full page loads.
 */
export async function GET() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("documents")
    .select("id, status, error_message");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ documents: data ?? [] });
}

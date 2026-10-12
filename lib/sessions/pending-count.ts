"use server";

/**
 * Server Action: live count of public reservations awaiting STAFF
 * confirmation (pending_confirmation = true, scheduled) — the nav badge on
 * "Por confirmar". Includes stale ones on purpose: a reservation whose time
 * passed without anyone acting still needs a decision (cancel it).
 * Read-only, called by the nav on every route change; no Supabase key in the
 * browser.
 */
import { createClient, hasSupabaseEnv } from "../supabase/server";

export async function getPendingCount(): Promise<number | null> {
  if (!hasSupabaseEnv()) return null;
  try {
    const { count, error } = await createClient()
      .from("sessions")
      .select("id", { count: "exact", head: true })
      .eq("pending_confirmation", true)
      .eq("status", "scheduled");
    if (error) return null;
    return count;
  } catch {
    // A count is decoration — never let it break the shell.
    return null;
  }
}

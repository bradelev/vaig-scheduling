"use server";

/**
 * Server Action: live count of UPCOMING unmatched sessions (issues #82/#95).
 * Owner decision 2026-07-27: the badge tracks sessions still ahead (from
 * this instant on) — the urgent slice of the queue: tomorrow's need
 * identifying before the 16:00 batch, later-today's client walks in today.
 * The historic backlog stays visible inside the screen via its chips, not
 * on the nav. Read-only, called by the nav on every route change; no
 * Supabase key in the browser.
 */
import { createClient, hasSupabaseEnv } from "../supabase/server";

export async function getUnmatchedCount(): Promise<number | null> {
  if (!hasSupabaseEnv()) return null;
  try {
    const { count, error } = await createClient()
      .from("v_unmatched")
      .select("id", { count: "exact", head: true })
      .gte("starts_at", new Date().toISOString());
    if (error) return null;
    return count;
  } catch {
    // A count is decoration — never let it break the shell.
    return null;
  }
}

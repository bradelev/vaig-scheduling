"use server";

import { createClient } from "@/lib/supabase/server";

/**
 * Lightweight client list for the "Nueva sesión" picker (perf 2026-08-17).
 * The page used to await the full ~1300-row client list before rendering,
 * which made the screen "feel dead" on click. Now the page renders instantly
 * and this action loads the list in the background; the picker filters it
 * locally once it arrives (small dataset, so client-side search stays instant
 * with no per-keystroke latency).
 *
 * Runs on the staff session client — RLS staff_full_access gates it, the anon
 * key never reaches the browser.
 */
export type ClientPick = { id: string; full_name: string; phone: string };

export async function fetchClientsForPicker(): Promise<ClientPick[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id, full_name, phone")
    .order("full_name");
  if (error) throw new Error(`fetchClientsForPicker: ${error.message}`);
  return (data ?? []) as ClientPick[];
}

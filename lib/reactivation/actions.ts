"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * Server Actions for the Reactivation view (PRD FR-4, issues E3-T4 + #53).
 * A contact now records an OUTCOME — that closes the loop: the view stops
 * re-showing a declined client every ~22 days (14-day grace after any
 * contact, 60 for 'declined'; windows live in the v_reactivation SQL).
 * Runs on the STAFF session client (not the service role): RLS
 * staff_full_access allows the update — least privilege.
 */

// "use server" modules may only export async functions — keep the const
// internal and export the (erased) type only.
const OUTCOMES = ["rebooked", "declined", "no_reply"] as const;
export type ReactivationOutcome = (typeof OUTCOMES)[number];

export async function markContactOutcome(
  clientId: string,
  outcome: ReactivationOutcome,
): Promise<void> {
  if (!OUTCOMES.includes(outcome)) {
    throw new Error(`invalid outcome: ${outcome}`);
  }
  const supabase = createClient();
  const { error } = await supabase
    .from("clients")
    .update({
      last_reactivation_at: new Date().toISOString(),
      reactivation_outcome: outcome,
    })
    .eq("id", clientId);
  if (error) {
    throw new Error(error.message);
  }
  revalidatePath("/reactivacion");
  revalidatePath("/clientas");
}

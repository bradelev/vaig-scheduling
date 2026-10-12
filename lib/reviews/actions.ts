"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../supabase/server";
import { requireStaff } from "../auth/require-staff";

/**
 * Server Actions for the Google review feature (2026-08-10). Runs on the STAFF
 * session client (not the service role): RLS staff_full_access allows the
 * update — least privilege, same as the reactivation actions.
 *
 * Google's API never tells us who left a review, so `reviewed_at` is a MANUAL
 * mark: the receptionist ticks it when she learns a client reviewed, and that
 * client drops out of v_review_candidates for good. `review_requested_at` is
 * set when the ask goes out (manually here, automatically once the template
 * lands) so we respect the grace window.
 */

/** Mark a client as having reviewed — removes her from the candidates view. */
export async function markReviewed(clientId: string): Promise<void> {
  const auth = await requireStaff();
  if ("error" in auth) throw new Error(auth.error);
  const supabase = createClient();
  const { error } = await supabase
    .from("clients")
    .update({ reviewed_at: new Date().toISOString() })
    .eq("id", clientId);
  if (error) {
    throw new Error(error.message);
  }
  revalidatePath("/resenas");
}

/** Record that we asked this client for a review (starts the grace window). */
export async function markReviewRequested(clientId: string): Promise<void> {
  const auth = await requireStaff();
  if ("error" in auth) throw new Error(auth.error);
  const supabase = createClient();
  const { error } = await supabase
    .from("clients")
    .update({ review_requested_at: new Date().toISOString() })
    .eq("id", clientId);
  if (error) {
    throw new Error(error.message);
  }
  revalidatePath("/resenas");
}

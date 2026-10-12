/**
 * In-action staff re-check for privileged Server Actions. The middleware
 * already gates every app route on the staff allowlist, but Next dispatches
 * Server Actions by id from any route the middleware lets through (e.g.
 * /login is public), and the actions run with the service role — so an action
 * that writes must not trust the route alone (docs/TECH_DEBT.md, 2026-07-15
 * "requireStaff"). Validates the JWT (getUser, never getSession) and the
 * allowlist; returns a user-facing error otherwise.
 */
import { isStaffEmail } from "./allowlist";
import { isTransientAuthError } from "./route-decision";
import { createClient } from "../supabase/server";

export async function requireStaff(): Promise<{ ok: true; email: string } | { error: string }> {
  try {
    // One retry on a TRANSIENT failure (network blip, 5xx), same rule as the
    // middleware: a healthy staff session must not read as "No autorizado."
    const supabase = createClient();
    let result = await supabase.auth.getUser();
    if (result.error && isTransientAuthError(result.error)) {
      result = await supabase.auth.getUser();
    }
    const email = result.data.user?.email ?? null;
    if (!email || !isStaffEmail(email)) return { error: "No autorizado." };
    return { ok: true, email };
  } catch {
    return { error: "No autorizado." };
  }
}

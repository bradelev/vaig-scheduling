"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isStaffEmail } from "./allowlist";
import { createClient, hasSupabaseEnv } from "../supabase/server";
import { serviceClient } from "../supabase/service";
import {
  RATE_LIMITS,
  clientIpFrom,
  hitRateLimit,
  type RateLimitRule,
} from "../security/rate-limit";

/**
 * Server Actions for the login flow (issue E3-T1; OTP-code login 2026-08-20).
 * Everything runs server-side: the browser never sees the Supabase URL or key.
 *
 * Why a 6-digit CODE instead of a magic link: on an iOS home-screen web app
 * (standalone web-clip), tapping an email link opens the DEFAULT BROWSER, not
 * the web-clip, and the two have separate cookie stores — so the session lands
 * in the browser and the web-clip stays logged out. A code the user reads in
 * Mail and TYPES back into the app keeps the whole login inside the same
 * container. `signInWithOtp` sends a code (not a link) whenever the email
 * template renders `{{ .Token }}` instead of `{{ .ConfirmationURL }}`
 * (see docs/deploy.md §5.1).
 */

/**
 * Step 1 — email in, code out. Keeps the allowlist gate and the
 * anti-enumeration behavior: an address that isn't staff gets the SAME "code
 * sent" screen but no email, so the response never reveals who is on the list.
 */
/**
 * One hit per (rule, key); true only if every counter allows it. Fail-closed:
 * if the limiter can't be reached the login is refused, same as the public
 * routes. Applied BEFORE the allowlist check so staff and outsiders get the
 * same answer (no enumeration through the limiter).
 */
async function loginAllowed(
  hits: Array<[RateLimitRule, string]>,
): Promise<"ok" | "rate" | "config"> {
  let db: ReturnType<typeof serviceClient>;
  try {
    db = serviceClient();
  } catch {
    // Missing service env is a deployment problem, not "too many attempts".
    return "config";
  }
  try {
    for (const [rule, key] of hits) {
      const decision = await hitRateLimit(db, rule, key);
      if (!decision.allowed) return "rate";
    }
    return "ok";
  } catch {
    return "rate";
  }
}

export async function sendCode(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) redirect("/login?error=invalid");
  if (!hasSupabaseEnv()) redirect("/login?error=config");

  const ip = clientIpFrom(headers());
  const gate = await loginAllowed([[RATE_LIMITS.staffSendCode, ip]]);
  if (gate !== "ok") redirect(`/login?error=${gate}`);

  // Outsiders: pretend-success, no email sent. Carry the email forward so the
  // code screen can prefill it (harmless — the sender already typed it).
  const emailParam = encodeURIComponent(email);
  if (!isStaffEmail(email)) redirect(`/login?step=code&email=${emailParam}`);

  const supabase = createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      // First staff login creates the account; the allowlist above is the
      // only gate that matters.
      shouldCreateUser: true,
    },
  });
  if (error) {
    // No PII in server logs: the error message alone is enough.
    console.error(`signInWithOtp (code) failed: ${error.message}`);
    redirect("/login?error=send");
  }
  redirect(`/login?step=code&email=${emailParam}`);
}

/**
 * Step 2 — verify the 6-digit code and set the session cookie. On success the
 * middleware's allowlist guard takes over. Errors come back as a readable
 * Spanish message on the code screen (email preserved so the user can retry).
 */
export async function verifyCode(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const token = String(formData.get("token") ?? "").trim();
  const emailParam = encodeURIComponent(email);
  if (!hasSupabaseEnv()) redirect("/login?error=config");
  if (!email || !token) {
    redirect(`/login?step=code&email=${emailParam}&error=code`);
  }
  const ip = clientIpFrom(headers());
  const gate = await loginAllowed([
    [RATE_LIMITS.staffVerifyCode, ip],
    [RATE_LIMITS.staffVerifyEmail, email.toLowerCase()],
  ]);
  if (gate !== "ok") redirect(`/login?step=code&email=${emailParam}&error=${gate}`);

  // Defense in depth: never mint a session for a non-staff address, even if a
  // code somehow reached them.
  if (!isStaffEmail(email)) {
    redirect(`/login?step=code&email=${emailParam}&error=code`);
  }

  const supabase = createClient();
  const { error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: "email",
  });
  if (error) {
    console.error(`verifyOtp failed: ${error.message}`);
    redirect(`/login?step=code&email=${emailParam}&error=code`);
  }
  redirect("/");
}

export async function signOut(): Promise<void> {
  if (hasSupabaseEnv()) {
    const supabase = createClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}

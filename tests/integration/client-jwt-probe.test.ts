/**
 * Phase 1 probe (CI-only): validate the CLIENT session mechanism —
 * synthetic-email user + phone in metadata (Braulio's choice, 2026-08-28).
 *
 * WHY NOT a Supabase phone user: the stack has phone login disabled
 * ([auth.sms] enable_signup=false, to avoid an SMS provider). Admin-creating /
 * signing in a phone user errors "Phone logins are disabled". So a client is a
 * normal EMAIL user (email login already works — staff use it) with a synthetic
 * email derived from the phone, and the REAL phone (E.164, with '+') stored in
 * APP metadata (admin-only writable — a client can't forge it via updateUser).
 * The custom_access_token hook (migration 20260828040536) copies that phone
 * into the JWT as a top-level `phone` claim for the client-owns-own RLS.
 *
 * This probe proves end to end:
 *  1. admin.createUser({ email, email_confirm, app_metadata:{ phone } }) works.
 *  2. We can mint a session for that user (sign in).
 *  3. The hook lifts the phone to a TOP-LEVEL `phone` claim, E.164 with '+' —
 *     so it compares against clients.phone with NO '+'-mismatch.
 * All data invented (fixture E.164). Runs against the runner's Supabase stack.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";

const CLIENT_PHONE = "+59891112233"; // E.164, with '+', as clients.phone stores it
const SYNTHETIC_EMAIL = "59891112233@clientes.vaig.internal";
const CLIENT_PASSWORD = "integration-test-client-pw";

let service: SupabaseClient;
let client: SupabaseClient;
let clientUserId: string;
let session: { access_token: string } | null = null;

beforeAll(async () => {
  const { url, anonKey, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);

  // A normal EMAIL user (email login is enabled) with the real phone in
  // metadata. email_confirm so no confirmation mail is needed; production mints
  // the session via the admin API after our own WhatsApp-code verification.
  const { data: created, error } = await service.auth.admin.createUser({
    email: SYNTHETIC_EMAIL,
    password: CLIENT_PASSWORD,
    email_confirm: true,
    // app_metadata (NOT user_metadata): only the admin API writes it, so the
    // client can't forge their phone. The hook lifts it to a top-level claim.
    app_metadata: { phone: CLIENT_PHONE },
  });
  if (error) throw new Error(`admin.createUser(email) failed: ${error.message}`);
  clientUserId = created.user.id;

  client = createClient(url, anonKey, clientOptions);
  const { data: signIn, error: signInErr } = await client.auth.signInWithPassword({
    email: SYNTHETIC_EMAIL,
    password: CLIENT_PASSWORD,
  });
  if (signInErr) throw new Error(`signIn(email) failed: ${signInErr.message}`);
  session = signIn.session ? { access_token: signIn.session.access_token } : null;
});

afterAll(async () => {
  if (clientUserId) await service.auth.admin.deleteUser(clientUserId);
});

describe("synthetic-email client user + phone metadata (session probe)", () => {
  it("creates the user and mints a session", () => {
    expect(session?.access_token).toBeTruthy();
  });

  it("the custom_access_token hook lifts phone (from app_metadata) to a TOP-LEVEL claim", () => {
    // Migration 20260828040536 created the hook + config.toml enables it, so the
    // JWT carries `phone` at the top level (E.164 with '+') — exactly what the
    // client-owns-own RLS reads via client_phone(). The source is app_metadata
    // (admin-only writable), so the client can't forge this.
    const claims = decodeJwt(session!.access_token);
    expect(claims.phone).toBe(CLIENT_PHONE);
  });
});

/** Decode a JWT payload (no verification — we only inspect claims in a test). */
function decodeJwt(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  const json = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(json);
}

/**
 * Real I/O ports for the client phone-login flow (Phase 1 slice 3). Implements
 * the OtpPorts interface against Supabase (service role) + the WhatsApp send.
 * Thin by design — all decisions live in flow.ts / otp.ts. Node-only (uses the
 * service-role client and process.env).
 *
 * The `establishSession` port is the delicate one: it turns a verified phone
 * into a browser session by (1) find-or-creating the synthetic-email client
 * user with the phone in APP_METADATA (admin-only, unforgeable), and (2) minting
 * a session for that user via a server-generated magic-link token which the
 * route then exchanges into a cookie. See setClientSessionCookie in the route.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "../supabase/service";
import { sendLoginCode } from "./whatsapp";
import { RATE_WINDOW_MS, type CodeRecord } from "./otp";
import type { OtpPorts } from "./flow";

/** The synthetic email for a client identified by an E.164 phone (with '+'). */
export function syntheticEmail(phone: string): string {
  // Strip the '+' for a valid local-part; the real phone lives in app_metadata.
  return `${phone.replace(/^\+/, "")}@clientes.vaig.internal`;
}

/**
 * Build the real ports. `nowMs` and `pepper` are read here so the route stays
 * declarative. `onSessionToken` is how the route receives the minted token to
 * set the cookie (kept out of this module so cookie plumbing stays in the
 * route). For request-code, pass a no-op onSessionToken.
 */
export function makePorts(opts: {
  nowMs: number;
  onSessionToken?: (token: { accessToken: string; refreshToken: string }) => Promise<void>;
}): OtpPorts {
  const db = serviceClient();
  const pepper = process.env.OTP_PEPPER ?? "";

  return {
    pepper,
    nowMs: opts.nowMs,
    rateWindowMs: RATE_WINDOW_MS,

    async recentCodeCount(phone, sinceMs) {
      const { count, error } = await db
        .from("login_codes")
        .select("id", { count: "exact", head: true })
        .eq("phone", phone)
        .gt("created_at", new Date(sinceMs).toISOString());
      if (error) throw new Error(`recentCodeCount: ${error.message}`);
      return count ?? 0;
    },

    async insertCode({ phone, codeHash, expiresAt }) {
      const { error } = await db
        .from("login_codes")
        .insert({ phone, code_hash: codeHash, expires_at: expiresAt });
      if (error) throw new Error(`insertCode: ${error.message}`);
    },

    async sendCode(phone, code) {
      await sendLoginCode(phone, code);
    },

    async activeCode(phone) {
      const { data, error } = await db
        .from("login_codes")
        .select("id, code_hash, expires_at, attempts, consumed_at")
        .eq("phone", phone)
        .is("consumed_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`activeCode: ${error.message}`);
      return (data as (CodeRecord & { id: string }) | null) ?? null;
    },

    async bumpAttempts(codeId) {
      // Conditional atomic increment (race-safe cap). Returns the new attempts
      // count, or null if the row was already at/over the cap → this guess
      // doesn't count as a valid attempt (the flow treats null as a failure).
      const { data, error } = await db.rpc("bump_login_code_attempt", {
        code_id: codeId,
      });
      if (error) throw new Error(`bumpAttempts: ${error.message}`);
      return data === null || data === undefined ? null : (data as number);
    },

    async consumeCode(codeId) {
      const { error } = await db
        .from("login_codes")
        .update({ consumed_at: new Date(opts.nowMs).toISOString() })
        .eq("id", codeId);
      if (error) throw new Error(`consumeCode: ${error.message}`);
    },

    async establishSession(phone) {
      const email = syntheticEmail(phone);
      const userId = await findOrCreateClientUser(db, email, phone);
      await ensureAppMetadataPhone(db, userId, phone);
      const token = await mintSession(db, email);
      if (opts.onSessionToken) await opts.onSessionToken(token);
    },
  };
}

/** Create the synthetic-email client user; null when the email is already taken. */
async function createClientUser(
  db: SupabaseClient,
  email: string,
  phone: string,
): Promise<string | null> {
  const created = await db.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { phone },
  });
  return !created.error && created.data.user ? created.data.user.id : null;
}

/**
 * Find the synthetic-email client user or create it (phone in app_metadata).
 *
 * Security: the synthetic email is guessable and Supabase email sign-up stays
 * on (staff login creates users on first sign-in), so anyone holding the anon
 * key could pre-register `<phone>@clientes.vaig.internal` with a password and
 * wait for the real client to log in. An existing user is therefore adopted
 * ONLY if its app_metadata.phone (writable by the service role alone, and set
 * at creation by createClientUser) already equals this phone. Anything else
 * is a squatter: it is deleted and the user is recreated. Nothing references
 * auth user ids (client identity is the phone claim), so recreating is safe.
 */
export async function findOrCreateClientUser(
  db: SupabaseClient,
  email: string,
  phone: string,
): Promise<string> {
  const created = await createClientUser(db, email, phone);
  if (created) return created;

  // Already registered → look up the id directly. NOT listUsers().find(): that
  // only scans the first page (default 50), so a returning client whose user is
  // beyond page 1 would be "not found". The synthetic email is unique, so query
  // auth.users by email via the service-role RPC (see the migration).
  const { data, error } = await db.rpc("client_user_id_by_email", { p_email: email });
  if (error) throw new Error(`client_user_id_by_email: ${error.message}`);
  if (!data) throw new Error("client user not found after create conflict");
  const existingId = data as string;

  const { data: got, error: getError } = await db.auth.admin.getUserById(existingId);
  if (getError || !got.user) {
    throw new Error(`getUserById: ${getError?.message ?? "user not found"}`);
  }
  if (got.user.app_metadata?.phone === phone) return existingId;

  // No PII in logs: the id is enough to investigate.
  console.error(`client-auth: replacing user ${existingId} without the service-set phone claim`);
  const removed = await db.auth.admin.deleteUser(existingId);
  if (removed.error) throw new Error(`deleteUser: ${removed.error.message}`);
  const recreated = await createClientUser(db, email, phone);
  if (!recreated) throw new Error("client user re-create failed");
  return recreated;
}

/** Ensure app_metadata.phone is set (unforgeable identity source for the hook). */
async function ensureAppMetadataPhone(
  db: SupabaseClient,
  userId: string,
  phone: string,
): Promise<void> {
  const { error } = await db.auth.admin.updateUserById(userId, {
    app_metadata: { phone },
  });
  if (error) throw new Error(`updateUserById: ${error.message}`);
}

/**
 * Mint a session for the synthetic-email user WITHOUT a password: generate a
 * magic-link token with the admin (service) client, then EXCHANGE it on a
 * THROWAWAY anon client — NOT the service client.
 *
 * WHY the throwaway client: verifyOtp writes the freshly-minted CLIENT session
 * into the client instance it runs on. If we called it on the service client,
 * that instance would silently downgrade from service_role to the client's JWT
 * for every later query in the request — a privilege-drop landmine. The
 * throwaway is discarded immediately, so the service client stays service_role.
 * No email is sent (generateLink returns the token to us directly).
 */
async function mintSession(
  db: SupabaseClient,
  email: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const { data, error } = await db.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (error || !data.properties?.hashed_token) {
    throw new Error(`generateLink: ${error?.message ?? "no token"}`);
  }

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Supabase env not set");
  // A fresh, throwaway anon client — used ONLY for this exchange, then dropped.
  const ephemeral = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: verified, error: verifyErr } = await ephemeral.auth.verifyOtp({
    type: "magiclink",
    token_hash: data.properties.hashed_token,
  });
  if (verifyErr || !verified.session) {
    throw new Error(`verifyOtp: ${verifyErr?.message ?? "no session"}`);
  }
  return {
    accessToken: verified.session.access_token,
    refreshToken: verified.session.refresh_token,
  };
}

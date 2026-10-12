/**
 * calendar-write edge function (PRD Part II §II.7/§II.8, issue #118).
 *
 * Writes the Google Calendar MIRROR event for an app-origin session. Invoked
 * by the Next.js CRUD server actions (Node) over HTTP with the service role —
 * all Google Calendar auth stays in Deno, reusing sync-calendar's JWT/RS256
 * pattern (only the OAuth scope is widened to calendar.events).
 *
 * Contract: { op: "create"|"update"|"delete", session: MirrorSession }.
 * The write is best-effort and DECOUPLED from the DB session write: the
 * session is the source of truth (it exists with gcal_event_id NULL before
 * this runs); on a successful create/update this returns the event id so the
 * caller can PATCH it onto the session. A calendar failure never rolls back
 * the session — the row is simply "mirror pending" and can be retried.
 *
 * Idempotency: the event id is derived deterministically from the session id
 * (logic.eventIdForSession). Create uses events.insert (POST) with that id; a
 * retried create 409s ("already exists") and falls back to events.update
 * (PUT), so a retry updates the existing event rather than duplicating it.
 * Delete tolerates 404/410 (already gone = success).
 */
import { type MirrorSession } from "./logic.ts";
import { deleteMirror, upsertMirror } from "./client.ts";

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SA_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL") ?? "";
const SA_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY") ?? "";
const CALENDAR_ID = Deno.env.get("GOOGLE_CALENDAR_ID") ?? "";

const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlStr = (s: string) => b64url(new TextEncoder().encode(s));

/**
 * Google OAuth token with WRITE scope. Same JWT/RS256 flow as sync-calendar's
 * googleAccessToken, but scope calendar.events (read+write) instead of
 * calendar.readonly (PRD §II.8 — the SA already has write permission on the
 * shared calendar; this is the code-side widening).
 */
async function googleAccessToken(): Promise<string> {
  const pem = SA_KEY.replace(/\\n/g, "\n").replace(/^"|"$/g, "");
  const der = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const keyBytes = Uint8Array.from(atob(der), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const claim = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." +
    b64urlStr(JSON.stringify({
      iss: SA_EMAIL,
      scope: "https://www.googleapis.com/auth/calendar.events",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }));
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(claim),
  );
  const assertion = `${claim}.${b64url(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`google token: HTTP ${res.status}`);
  const { access_token } = await res.json();
  return access_token;
}

Deno.serve(async (req) => {
  // Only the service role (the CRUD server actions) may write the calendar.
  const auth = req.headers.get("authorization") ?? "";
  if (!SERVICE_KEY || auth !== `Bearer ${SERVICE_KEY}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (req.method !== "POST") {
    return Response.json({ error: "use POST" }, { status: 405 });
  }

  const body = await req.json().catch(() => null);
  const op = body?.op as string | undefined;
  const session = body?.session as MirrorSession | undefined;
  if (!op || (op !== "delete" && !session) || (op === "delete" && !body?.sessionId)) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  try {
    const token = await googleAccessToken();
    if (op === "create" || op === "update") {
      const eventId = await upsertMirror(token, CALENDAR_ID, session!, op);
      return Response.json({ ok: true, eventId });
    }
    if (op === "delete") {
      await deleteMirror(token, CALENDAR_ID, body.sessionId as string);
      return Response.json({ ok: true });
    }
    return Response.json({ error: `unknown op: ${op}` }, { status: 400 });
  } catch (err) {
    // Surface the failure so the caller keeps the session "mirror pending"
    // (gcal_event_id NULL) and can retry — never a silent success.
    return Response.json(
      { ok: false, error: String(err) },
      { status: 502 },
    );
  }
});

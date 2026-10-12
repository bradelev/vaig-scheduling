/**
 * Best-effort bridge from the Next.js CRUD server actions to the Deno
 * `calendar-write` edge function (issue #118, PRD §II.7). All Google Calendar
 * auth lives in Deno; the server action just POSTs the intent here.
 *
 * DECOUPLED by design: the DB session is the source of truth and already
 * exists (with gcal_event_id NULL) before this runs. A calendar failure never
 * throws into the caller — it returns `{ ok: false }` and the session stays
 * "mirror pending" (gcal NULL), to be retried by a future reconcile. On a
 * successful create/update the caller PATCHes the returned eventId onto the
 * session so the sync can link them.
 */

export type MirrorSessionPayload = {
  id: string;
  starts_at: string;
  ends_at: string | null;
  client_name: string;
  service: string | null;
  /** Google Calendar colorId (1–11) for the attending employee, or null for
   *  the default color. Resolved from the staff catalog by the caller. */
  color_id: number | null;
};

type MirrorResult =
  | { ok: true; eventId?: string }
  | { ok: false; error: string };

function edgeConfig(): { url: string; key: string } | null {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  return { url: `${base}/functions/v1/calendar-write`, key };
}

async function callEdge(body: unknown): Promise<MirrorResult> {
  const cfg = edgeConfig();
  // If the function isn't configured (e.g. local dev without the stack), skip
  // silently — the session is still created; the mirror is just pending.
  if (!cfg) return { ok: false, error: "calendar-write not configured" };
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      return { ok: false, error: data?.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, eventId: data?.eventId };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Create/update the mirror event; returns the event id to store on the session. */
export function mirrorUpsert(
  session: MirrorSessionPayload,
  op: "create" | "update",
): Promise<MirrorResult> {
  return callEdge({ op, session });
}

/** Delete the mirror event for a session (idempotent; already-gone is fine). */
export function mirrorDelete(sessionId: string): Promise<MirrorResult> {
  return callEdge({ op: "delete", sessionId });
}

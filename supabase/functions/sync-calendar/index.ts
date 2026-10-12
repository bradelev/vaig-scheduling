/**
 * sync-calendar edge function (PRD FR-1, issue E2-T3).
 * Invoked hourly by pg_cron (cron migration lands in E2-T4). Reads the shop
 * calendar read-only, classifies (§7.0), upserts sessions and runs the §7.2
 * matching cascade. `backfill_days` in the body widens the past window for
 * the initial run (90).
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { transitionAlert } from "../_shared/alerting.ts";
import { notifyTransition, previousRunOk } from "../_shared/notify.ts";
import { chunked, type ClientLite, type RawEvent } from "./logic.ts";
import {
  type AliasRow,
  type Deps,
  type ExistingSession,
  type NewAlias,
  runSync,
  type SessionToMatch,
  type UpsertRow,
} from "./run.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
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

/** Import the SA PEM and sign a Google OAuth JWT with WebCrypto (RS256). */
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
      scope: "https://www.googleapis.com/auth/calendar.readonly",
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

async function fetchAllEvents(
  token: string,
  timeMin: string,
  timeMax: string,
): Promise<RawEvent[]> {
  const items: RawEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      showDeleted: "true", // cancellations must reach us as status=cancelled
      maxResults: "250",
      orderBy: "startTime",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${
        encodeURIComponent(CALENDAR_ID)
      }/events?${params}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`calendar events: HTTP ${res.status}`);
    const body = await res.json();
    items.push(...(body.items ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return items;
}

function realDeps(): Deps {
  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let token = "";

  return {
    now: () => new Date(),

    async fetchEvents(timeMin, timeMax) {
      token = await googleAccessToken();
      return fetchAllEvents(token, timeMin, timeMax);
    },

    async fetchExisting(gcalIds): Promise<ExistingSession[]> {
      // Chunked (issue #88): a 90-day backfill carries enough ids to exceed
      // the PostgREST URL limit — the unchunked version 400'd on backfills.
      return await chunked(gcalIds, 100, async (slice) => {
        const { data, error } = await db
          .from("sessions")
          .select("gcal_event_id, starts_at, reminder_sent_at, status")
          .in("gcal_event_id", slice);
        if (error) throw new Error(`fetchExisting: ${error.message}`);
        return (data ?? []) as ExistingSession[];
      });
    },

    async upsertSessions(rows: UpsertRow[]) {
      if (rows.length === 0) return;
      const { error } = await db
        .from("sessions")
        .upsert(rows, { onConflict: "gcal_event_id" });
      if (error) throw new Error(`upsertSessions: ${error.message}`);
    },

    async cancelExisting(gcalIds) {
      // Tombstones with no start: flip status on rows we already have; a
      // tombstone for an event we never synced simply has nothing to update.
      // Chunked (issue #88): a 90-day backfill with showDeleted can carry
      // hundreds of recurring-instance tombstones — same URL limit as
      // fetchExisting.
      await chunked(gcalIds, 100, async (slice) => {
        const { error } = await db
          .from("sessions")
          .update({ status: "cancelled" })
          .in("gcal_event_id", slice);
        if (error) throw new Error(`cancelExisting: ${error.message}`);
        return [];
      });
    },

    async resetReminder(gcalIds) {
      const { error } = await db
        .from("sessions")
        .update({ reminder_sent_at: null, reminder_wamid: null, confirmed_at: null })
        .in("gcal_event_id", gcalIds);
      if (error) throw new Error(`resetReminder: ${error.message}`);
    },

    async fetchUnmatched(): Promise<SessionToMatch[]> {
      // Dismissed rows are operator-confirmed non-sessions (issue #48):
      // never run the cascade over them.
      const { data, error } = await db
        .from("sessions")
        .select("id, gcal_event_id, raw_title, raw_description, source")
        .is("client_id", null)
        .neq("status", "cancelled")
        .is("dismissed_at", null);
      if (error) throw new Error(`fetchUnmatched: ${error.message}`);
      return data ?? [];
    },

    async fetchClients(): Promise<ClientLite[]> {
      const { data, error } = await db.from("clients").select("id, phone");
      if (error) throw new Error(`fetchClients: ${error.message}`);
      return data ?? [];
    },

    async fetchAliases(): Promise<AliasRow[]> {
      const { data, error } = await db
        .from("aliases")
        .select("client_id, alias_tokens");
      if (error) throw new Error(`fetchAliases: ${error.message}`);
      return data ?? [];
    },

    async applyMatch(sessionId, clientId, method) {
      const { error } = await db
        .from("sessions")
        .update({ client_id: clientId, match_method: method })
        .eq("id", sessionId)
        .is("client_id", null); // never overwrite a manual/existing match
      if (error) throw new Error(`applyMatch: ${error.message}`);
    },

    async insertAliases(rows: NewAlias[]) {
      if (rows.length === 0) return;
      // Skip rows whose raw_alias already exists (unique constraint).
      const { error } = await db
        .from("aliases")
        .upsert(
          rows.map((r) => ({ ...r, source: "phone_match" })),
          { onConflict: "raw_alias", ignoreDuplicates: true },
        );
      if (error) throw new Error(`insertAliases: ${error.message}`);
    },

    async dismissDiscarded(gcalIds) {
      // Same URL-length rationale as fetchExisting (issue #88).
      const rows = await chunked(gcalIds, 100, async (slice) => {
        const { data, error } = await db
          .from("sessions")
          .update({ dismissed_at: new Date().toISOString() })
          .in("gcal_event_id", slice)
          .is("client_id", null)
          .is("dismissed_at", null)
          .select("id");
        if (error) throw new Error(`dismissDiscarded: ${error.message}`);
        return (data ?? []) as { id: string }[];
      });
      return rows.length;
    },

    async startJobRun() {
      const { data, error } = await db
        .from("job_runs")
        .insert({ job: "sync-calendar" })
        .select("id")
        .single();
      if (error) throw new Error(`startJobRun: ${error.message}`);
      return data.id;
    },

    async finishJobRun(id, ok, detail) {
      await db
        .from("job_runs")
        .update({ finished_at: new Date().toISOString(), ok, detail })
        .eq("id", id);
    },
  };
}

Deno.serve(async (req) => {
  const auth = req.headers.get("authorization") ?? "";
  if (!SERVICE_KEY || auth !== `Bearer ${SERVICE_KEY}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let backfillDays: number | undefined;
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.backfill_days === "number") backfillDays = body.backfill_days;
  }
  const result = await runSync(realDeps(), { backfillDays });

  // OK↔fail transition alerts to the tech contact (issue E6-T3) —
  // best-effort, never changes the run outcome.
  try {
    const alert = transitionAlert(await previousRunOk("sync-calendar"), result.ok);
    if (alert) {
      await notifyTransition(
        "sync-calendar",
        alert,
        String((result.detail as { fatal?: string }).fatal ?? ""),
      );
    }
  } catch (err) {
    console.error(`notifications failed: ${String(err)}`);
  }

  return Response.json(result, { status: result.ok ? 200 : 500 });
});

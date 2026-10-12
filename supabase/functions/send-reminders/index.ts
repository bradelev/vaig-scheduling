/**
 * send-reminders edge function (PRD FR-2, issue E4-T2).
 * Invoked daily at 16:00 America/Montevideo by pg_cron (see migration
 * 0008_reschedule_send_reminders_16h) to remind every session of the next
 * local day. `dry_run` via body `{"dry_run": true}` or `?dry_run=1` logs
 * the selection without sending or marking anything.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { transitionAlert } from "../_shared/alerting.ts";
import {
  notifyDailySummary,
  notifyTransition,
  previousRunOk,
} from "../_shared/notify.ts";
import type { Candidate } from "./logic.ts";
import { type Deps, runSendReminders, type SendResult } from "./run.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WHATSAPP_TOKEN = Deno.env.get("WHATSAPP_TOKEN") ?? "";
const PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
const GRAPH_URL =
  `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

function realDeps(): Deps {
  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    now: () => new Date(),

    async fetchCandidates(fromIso, toIso, onlySessionId) {
      // FR-2 predicate, verbatim: scheduled, unconfirmed, unreminded,
      // matched, client not opted out, starting inside the window. External
      // bookings are excluded — External sends its own reminders (issue #69).
      let q = db
        .from("sessions")
        .select(
          "id, client_id, starts_at, service, clients!inner(full_name, phone, opted_out)",
        )
        .eq("status", "scheduled")
        .neq("source", "external")
        // A public-booking reservation still awaiting STAFF confirmation is
        // not a firm appointment: never remind it (the client would get
        // Confirmar/Reagendar buttons for a slot the team hasn't approved).
        .eq("pending_confirmation", false)
        .is("confirmed_at", null)
        .is("reminder_sent_at", null)
        .not("client_id", "is", null)
        .eq("clients.opted_out", false);
      // Immediate-reminder scope (issue #120): a single session identified by
      // id. The `id` uniquely identifies it, so we DELIBERATELY skip the day
      // window here — applying nextLocalDayWindow(now) would drop the session
      // if the local day rolled over between the CRUD call and this exec (a
      // late-night create, the exact case #120 protects). Every OTHER predicate
      // condition (opted_out, confirmed, reminder_sent_at, external) still
      // guards, so an ineligible session yields nothing.
      if (onlySessionId) {
        // Skip the strict next-local-day window (it would drop a session whose
        // day rolled over between the CRUD call and this exec), but keep a
        // LOOSE sanity band so the id-scoped endpoint can't remind an
        // arbitrary-date session: [now, now+72h] covers today + the immediate
        // window with margin, without reintroducing the midnight-crossing bug.
        const now = new Date().getTime();
        q = q
          .eq("id", onlySessionId)
          .gte("starts_at", new Date(now).toISOString())
          .lt("starts_at", new Date(now + 72 * 3_600_000).toISOString());
      } else {
        q = q.gte("starts_at", fromIso).lt("starts_at", toIso);
      }
      const { data, error } = await q;
      if (error) throw new Error(`fetchCandidates: ${error.message}`);
      // deno-lint-ignore no-explicit-any
      return (data as any[]).map((row): Candidate => ({
        id: row.id,
        client_id: row.client_id,
        starts_at: row.starts_at,
        service: row.service,
        full_name: row.clients.full_name,
        phone: row.clients.phone,
      }));
    },

    async fetchReminded(clientIds, fromIso, toIso) {
      const { data, error } = await db
        .from("sessions")
        .select("client_id, starts_at")
        .in("client_id", clientIds)
        .not("reminder_sent_at", "is", null)
        .gte("starts_at", fromIso)
        .lt("starts_at", toIso);
      if (error) throw new Error(`fetchReminded: ${error.message}`);
      return data ?? [];
    },

    async fetchExternalCovered(clientIds, fromIso, toIso) {
      // Only SCHEDULED external rows cover a day (issue #69): a cancelled
      // External booking reminds nobody, so its manual twin stays eligible.
      const { data, error } = await db
        .from("sessions")
        .select("client_id, starts_at")
        .in("client_id", clientIds)
        .eq("source", "external")
        .eq("status", "scheduled")
        .gte("starts_at", fromIso)
        .lt("starts_at", toIso);
      if (error) throw new Error(`fetchExternalCovered: ${error.message}`);
      return data ?? [];
    },

    async sendTemplate(payload): Promise<SendResult> {
      const res = await fetch(GRAPH_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const summary = JSON.stringify(body?.error ?? body).slice(0, 300);
        return { ok: false, error: `HTTP ${res.status}: ${summary}` };
      }
      const wamid = body?.messages?.[0]?.id;
      if (!wamid) return { ok: false, error: "no wamid in Graph response" };
      return { ok: true, wamid };
    },

    async markSent(sessionId, wamid) {
      const { error } = await db
        .from("sessions")
        .update({
          reminder_sent_at: new Date().toISOString(),
          reminder_wamid: wamid,
        })
        .eq("id", sessionId)
        .is("reminder_sent_at", null); // never overwrite an existing mark
      if (error) throw new Error(error.message);
    },

    async startJobRun() {
      const { data, error } = await db
        .from("job_runs")
        .insert({ job: "send-reminders" })
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
  // The platform already verifies a JWT; on top of that, only the service
  // role (the cron job / an admin) may trigger sends — the anon key must
  // not be enough.
  const auth = req.headers.get("authorization") ?? "";
  if (!SERVICE_KEY || auth !== `Bearer ${SERVICE_KEY}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
  // Immediate-reminder scope (issue #120): a `session_id` in the POST body
  // restricts the run to that one session (the late-created-session fix).
  let onlySessionId: string | undefined;
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body?.dry_run === true) dryRun = true;
    if (typeof body?.session_id === "string") onlySessionId = body.session_id;
  } else if (!dryRun) {
    // A stray GET must never trigger a real batch.
    return Response.json(
      { error: "use POST (or GET with ?dry_run=1)" },
      { status: 405 },
    );
  }

  // Rehearsal mode (issue #60): when set, every send goes to this phone
  // instead of the client's. Empty string counts as unset so a sloppy
  // `secrets set TEST_PHONE_OVERRIDE=''` can't abort production batches.
  const testPhoneOverride = Deno.env.get("TEST_PHONE_OVERRIDE") || undefined;

  const result = await runSendReminders(
    realDeps(),
    dryRun,
    testPhoneOverride,
    onlySessionId,
  );

  // Operational notifications (issue E6-T3): daily summary to the admin,
  // OK↔fail transitions to the tech contact. Best-effort — a notification
  // problem must never change the batch outcome; dry runs stay silent.
  if (!dryRun) {
    try {
      const detail = result.detail as {
        sent?: number;
        errors?: unknown[];
        fatal?: string;
      };
      const errorCount = detail.errors?.length ?? 0;
      // On a FATAL run detail carries no counts — a "0 enviados, 0 con
      // error" summary would read as a healthy zero-activity day to the
      // admin. Suppress it; the tech transition alert is the signal.
      if (!detail.fatal) {
        await notifyDailySummary(detail.sent ?? 0, errorCount);
      }
      const alert = transitionAlert(await previousRunOk("send-reminders"), result.ok);
      if (alert) {
        await notifyTransition(
          "send-reminders",
          alert,
          detail.fatal ?? (errorCount > 0 ? `${errorCount} envíos fallaron` : ""),
        );
      }
    } catch (err) {
      console.error(`notifications failed: ${String(err)}`);
    }
  }

  return Response.json(result, { status: result.ok ? 200 : 500 });
});

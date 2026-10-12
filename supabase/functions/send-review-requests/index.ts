/**
 * send-review-requests edge function (PRD §III, layer 3). Invoked daily by
 * pg_cron to ask loyal clients (3+ completed sessions, never reviewed, not
 * opted out) for a Google review the day AFTER their session. Idempotent on
 * clients.review_requested_at; `dry_run` logs the selection without sending.
 *
 * Twin of send-reminders but for the `pedido_resena` MARKETING template; the
 * Google link rides in the template's static URL button (no button param sent).
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { transitionAlert } from "../_shared/alerting.ts";
import {
  notifyReviewSummary,
  notifyTransition,
  previousRunOk,
} from "../_shared/notify.ts";
import type { ReviewCandidate } from "./logic.ts";
import { type Deps, runSendReviewRequests, type SendResult } from "./run.ts";

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

    async fetchCandidates(fromIso, toIso) {
      // Eligibility is enforced by v_review_candidates (3+ completed, not
      // reviewed, not opted out, outside the 90-day grace). Here we add the
      // time trigger: the client's LAST completed session was yesterday.
      const { data, error } = await db
        .from("v_review_candidates")
        .select("id, full_name, phone, last_completed_at")
        .gte("last_completed_at", fromIso)
        .lt("last_completed_at", toIso);
      if (error) throw new Error(`fetchCandidates: ${error.message}`);
      // deno-lint-ignore no-explicit-any
      return (data as any[]).map((row): ReviewCandidate => ({
        client_id: row.id,
        full_name: row.full_name,
        phone: row.phone,
        last_completed_at: row.last_completed_at,
      }));
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

    async markRequested(clientId) {
      const { error } = await db
        .from("clients")
        .update({ review_requested_at: new Date().toISOString() })
        .eq("id", clientId)
        .is("review_requested_at", null); // never overwrite an existing ask
      if (error) throw new Error(error.message);
    },

    async startJobRun() {
      const { data, error } = await db
        .from("job_runs")
        .insert({ job: "send-review-requests" })
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
  // The platform verifies a JWT; on top, only the service role (cron/admin)
  // may trigger sends — the anon key must not be enough.
  const auth = req.headers.get("authorization") ?? "";
  if (!SERVICE_KEY || auth !== `Bearer ${SERVICE_KEY}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body?.dry_run === true) dryRun = true;
  } else if (!dryRun) {
    // A stray GET must never trigger a real batch.
    return Response.json(
      { error: "use POST (or GET with ?dry_run=1)" },
      { status: 405 },
    );
  }

  // Rehearsal mode (issue #60): when set, every send goes to this phone.
  // Empty string counts as unset so a sloppy secret can't abort production.
  const testPhoneOverride = Deno.env.get("TEST_PHONE_OVERRIDE") || undefined;

  const result = await runSendReviewRequests(
    realDeps(),
    dryRun,
    testPhoneOverride,
  );

  // Operational notifications (issue E6-T3): daily summary + OK↔fail
  // transitions. Best-effort; dry runs stay silent.
  if (!dryRun) {
    try {
      const detail = result.detail as {
        sent?: number;
        errors?: unknown[];
        fatal?: string;
      };
      const errorCount = detail.errors?.length ?? 0;
      if (!detail.fatal) {
        await notifyReviewSummary(detail.sent ?? 0, errorCount);
      }
      const alert = transitionAlert(
        await previousRunOk("send-review-requests"),
        result.ok,
      );
      if (alert) {
        await notifyTransition(
          "send-review-requests",
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

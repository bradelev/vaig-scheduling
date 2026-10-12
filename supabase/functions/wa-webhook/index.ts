/**
 * wa-webhook edge function (PRD FR-3, issue E5-T1).
 * GET: Meta verification handshake.
 * POST: validate X-Hub-Signature-256, then apply Confirm/Reschedule buttons.
 * Anything that is not a recognized button → 200 with no side effect
 * (a human handles free text on the shop phone). Responds fast; at this
 * volume synchronous processing is enough (FR-3).
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  notifyRescheduleRequest,
  sendServiceWindowText,
} from "../_shared/notify.ts";
import {
  formatReminderDate,
  formatReminderTime,
} from "../send-reminders/logic.ts";
import { templateParam } from "../_shared/alerting.ts";
import {
  ackRecipient,
  botRedirectMessage,
  type ButtonAction,
  confirmAckMessage,
  parseButtonActions,
  parseRedirectSenders,
  RESCHED_ACK_MESSAGE,
  shouldReply,
  verifySignature,
} from "./logic.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

/** Applies one button action; throws on a DB error so the handler 500s. */
export type ApplyAction = (action: ButtonAction) => Promise<void>;

export type Config = {
  verifyToken: string;
  appSecret: string;
  applyAction: ApplyAction;
  /**
   * Fired after a reschedule action is applied (issue #62): the operator
   * gets pinged the moment a client taps "Reagendar", instead of whenever
   * someone next opens the app. Best-effort — a notification failure must
   * never change the webhook's response (a 500 would make Meta redeliver
   * an already-applied action just to retry a ping).
   */
  onReschedule?: (sessionId: string) => Promise<void>;
  /**
   * Fired after a confirm action is applied (issue #68): the client gets
   * her closing ack ("te esperamos el …"). Same best-effort semantics.
   */
  onConfirm?: (sessionId: string) => Promise<void>;
  /**
   * Fired once per sender of non-button inbound messages (issue #74): the
   * fixed redirect to the shop's human number. Wired only when
   * SHOP_WHATSAPP is set — the feature ships dark. Same best-effort
   * semantics: failures never change the response.
   */
  onFreeText?: (senderPhone: string) => Promise<void>;
};

/**
 * The webhook handler, decoupled from env and the DB client so it is fully
 * testable (invalid → 401, each button → the right write, free-text → 200).
 */
export async function handleRequest(req: Request, cfg: Config): Promise<Response> {
  const url = new URL(req.url);

  // GET: Meta verification — echo hub.challenge iff the token matches (FR-3).
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    if (mode === "subscribe" && cfg.verifyToken && token === cfg.verifyToken) {
      return new Response(challenge, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("forbidden", { status: 403 });
  }

  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // Signature check over the RAW body (FR-3): invalid → 401. Read once and
  // reuse for both verification and parsing — never re-serialize.
  const rawBody = await req.text();
  const valid = await verifySignature(
    rawBody,
    req.headers.get("x-hub-signature-256"),
    cfg.appSecret,
  );
  if (!valid) return new Response("invalid signature", { status: 401 });

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // A signed-but-unparseable body: acknowledge, do nothing.
    return Response.json({ ok: true }, { status: 200 });
  }

  try {
    for (const action of parseButtonActions(body)) {
      await cfg.applyAction(action);
      const after = action.kind === "reschedule" ? cfg.onReschedule : cfg.onConfirm;
      if (after) {
        try {
          await after(action.sessionId);
        } catch (err) {
          // No body/PII in logs; the action itself already applied.
          console.error(`wa-webhook notify failed: ${String(err)}`);
        }
      }
    }
  } catch (err) {
    // No body/PII in logs. Return 500 so Meta retries the delivery.
    console.error(`wa-webhook apply failed: ${String(err)}`);
    return Response.json({ ok: false }, { status: 500 });
  }

  // Free-text redirect (issue #74): best-effort, after the actions — a
  // redirect problem must never make Meta redeliver applied actions.
  if (cfg.onFreeText) {
    for (const sender of parseRedirectSenders(body)) {
      try {
        await cfg.onFreeText(sender);
      } catch (err) {
        console.error(`wa-webhook redirect failed: ${String(err)}`);
      }
    }
  }
  return Response.json({ ok: true }, { status: 200 });
}

/**
 * The mutation trusts the signed payload's session id and is deliberately
 * NOT sender-scoped — CONFIRM_{id}/RESCHED_{id} was set by us at send time
 * and the signature proves Meta origin (FR-3). supabase-js does not reject
 * on a PostgREST error, so check {error} and throw.
 */
function dbApplyAction(): ApplyAction {
  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return async (action) => {
    const { error } = action.kind === "confirm"
      ? await db
        .from("sessions")
        .update({ confirmed_at: new Date().toISOString() })
        .eq("id", action.sessionId)
      : await db
        .from("sessions")
        .update({ status: "reschedule_requested" })
        .eq("id", action.sessionId);
    if (error) throw new Error(`apply ${action.kind}: ${error.message}`);
  };
}

/**
 * Looks up the session the client tapped on and pings the admin channels
 * (issue #62). Full name goes to STAFF WhatsApp/email — same data as the
 * app — but never into logs; callers swallow whatever this throws.
 */
function dbNotifyReschedule(): (sessionId: string) => Promise<void> {
  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return async (sessionId) => {
    const { data, error } = await db
      .from("sessions")
      .select("starts_at, clients(full_name, phone)")
      .eq("id", sessionId)
      .single();
    if (error || !data) {
      throw new Error(`notify lookup: ${error?.message ?? "no row"}`);
    }
    // deno-lint-ignore no-explicit-any
    const client = (data as any).clients;
    const name = client?.full_name?.trim() || "Una clienta";

    // Admin ping (issue #62) and client ack (issue #66) are independent:
    // one channel failing must never silence the other. The rehearsal
    // override always wins the ack destination — a rehearsal tap must
    // never message the real client.
    const ackTo = ackRecipient(
      client?.phone ?? null,
      Deno.env.get("TEST_PHONE_OVERRIDE") || undefined,
    );
    const results = await Promise.allSettled([
      notifyRescheduleRequest(
        name,
        formatReminderDate(data.starts_at),
        formatReminderTime(data.starts_at),
      ),
      ackTo
        ? sendServiceWindowText(ackTo, RESCHED_ACK_MESSAGE)
        : Promise.resolve(),
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        // Error strings from notify.ts arrive digit-redacted; no PII here.
        console.error(`wa-webhook resched notify: ${String(r.reason)}`);
      }
    }
  };
}

/**
 * Confirm ack (issue #68): closes the loop for the client with her session's
 * date/time. Same override-safe destination rules as the reschedule ack.
 */
function dbAckConfirm(): (sessionId: string) => Promise<void> {
  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return async (sessionId) => {
    const { data, error } = await db
      .from("sessions")
      .select("starts_at, clients(phone)")
      .eq("id", sessionId)
      .single();
    if (error || !data) {
      throw new Error(`ack lookup: ${error?.message ?? "no row"}`);
    }
    const ackTo = ackRecipient(
      // deno-lint-ignore no-explicit-any
      (data as any).clients?.phone ?? null,
      Deno.env.get("TEST_PHONE_OVERRIDE") || undefined,
    );
    if (!ackTo) return;
    await sendServiceWindowText(
      ackTo,
      confirmAckMessage(
        formatReminderDate(data.starts_at),
        formatReminderTime(data.starts_at),
      ),
    );
  };
}

/**
 * Free-text redirect (issue #74): reply at most once per sender per 24h
 * with the fixed pointer to the shop's human number. Send first, record
 * after — a failed send must stay retryable, a failed record only risks
 * one duplicate. Error strings are digit-redacted before they can reach
 * the caller's console.error.
 */
function dbRedirectFreeText(shopWa: string): (sender: string) => Promise<void> {
  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const message = botRedirectMessage(shopWa);
  return async (sender) => {
    const { data, error } = await db
      .from("bot_autoreplies")
      .select("replied_at")
      .eq("phone", sender)
      .maybeSingle();
    if (error) throw new Error(`redirect lookup: ${templateParam(error.message)}`);
    if (!shouldReply(data?.replied_at ?? null, Date.now())) return;

    await sendServiceWindowText(sender, message);

    const { error: upsertError } = await db
      .from("bot_autoreplies")
      .upsert({ phone: sender, replied_at: new Date().toISOString() });
    if (upsertError) {
      throw new Error(`redirect record: ${templateParam(upsertError.message)}`);
    }
  };
}

// Only start the server when run as the function entry point — importing
// this module from a test must not bind a port.
if (import.meta.main) {
  // The redirect ships dark: without the shop's human number there is
  // nothing safe to point people at, so the hook stays unwired.
  const shopWa = Deno.env.get("SHOP_WHATSAPP") || undefined;
  Deno.serve((req) =>
    handleRequest(req, {
      verifyToken: Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? "",
      appSecret: Deno.env.get("META_APP_SECRET") ?? "",
      applyAction: dbApplyAction(),
      onReschedule: dbNotifyReschedule(),
      onConfirm: dbAckConfirm(),
      onFreeText: shopWa ? dbRedirectFreeText(shopWa) : undefined,
    })
  );
}

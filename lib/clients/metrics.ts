/**
 * Reminder-response metrics (PRD §11, issue E3-T9): the aggregate the audit
 * found missing — confirmed_at was captured per row but never summed. The
 * button-response rate is the agreed no-show PROXY (real attendance is
 * structurally unmeasurable: the calendar is read-only by contract §3).
 * Source of truth is the sessions table, not job_runs sums: per session we
 * know exactly whether a reminder went out and what came back.
 */

const DAY_MS = 86_400_000;
export const METRICS_WINDOW_DAYS = 7;

/** The §11 target: ≥50% of reminded sessions get a button response. */
export const RESPONSE_TARGET = 0.5;

export type RemindedSession = {
  reminder_sent_at: string | null;
  confirmed_at: string | null;
  status: string;
};

export type ReminderMetrics = {
  sent: number;
  confirmed: number;
  rescheduled: number;
  /** (confirmed + rescheduled) / sent — null when sent is 0. */
  responseRate: number | null;
};

/**
 * Aggregates sessions whose reminder went out in the last 7 days. A
 * "response" is a confirmation OR a reschedule request; a session counts
 * once (reschedule wins if both are somehow set — asking to reschedule is
 * the later, operative signal).
 */
export function reminderMetrics(
  rows: RemindedSession[],
  nowMs: number,
): ReminderMetrics {
  const from = nowMs - METRICS_WINDOW_DAYS * DAY_MS;
  let sent = 0;
  let confirmed = 0;
  let rescheduled = 0;
  for (const row of rows) {
    if (!row.reminder_sent_at) continue;
    // A session cancelled after its reminder went out says nothing about
    // whether reminders elicit responses — the shop cancelled it. Keeping
    // it in the denominator would make the §11 rate systematically
    // pessimistic (cancelExisting never clears reminder_sent_at).
    if (row.status === "cancelled") continue;
    const at = new Date(row.reminder_sent_at).getTime();
    if (at < from || at > nowMs) continue;
    sent++;
    if (row.status === "reschedule_requested") rescheduled++;
    else if (row.confirmed_at) confirmed++;
  }
  const responded = confirmed + rescheduled;
  return {
    sent,
    confirmed,
    rescheduled,
    responseRate: sent === 0 ? null : responded / sent,
  };
}

const HOUR_MS = 3_600_000;

/**
 * A scheduled session with its reminder state — for the "no aviso" alert. Only
 * non-External sessions are candidates (External reminds its own; those never get
 * a VAIG reminder, so a null reminder there is not a miss). The page's query
 * already excludes external + cancelled; this stays defensive.
 */
export type ReminderCheckSession = {
  id: string;
  client_id: string;
  full_name: string;
  starts_at: string;
  reminder_sent_at: string | null;
  status: string;
  source: string | null;
};

export type MissedReminder = {
  id: string;
  full_name: string;
  starts_at: string;
};

/**
 * Name from a PostgREST embedded to-one `clients` relation. The generic types
 * declare the embed as an array, but at RUNTIME a to-one join returns a single
 * OBJECT (as send-reminders reads it: row.clients.full_name). Accept object,
 * array, or null so the name resolves regardless — the array-only access
 * (`clients[0]`) returned undefined against the real object shape and printed
 * "(sin nombre)" for every row (the no-aviso alert bug, 2026-08-13).
 */
export function joinedClientName(
  clients: { full_name: string } | { full_name: string }[] | null | undefined,
): string {
  if (!clients) return "(sin nombre)";
  const row = Array.isArray(clients) ? clients[0] : clients;
  return row?.full_name?.trim() || "(sin nombre)";
}

/** `${client_id}|${YYYY-MM-DD}` in Montevideo — the coverage key. */
function clientDayKey(clientId: string, iso: string): string {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
  return `${clientId}|${day}`;
}

/** Coverage set from scheduled External sessions: client|day keys reminded by
 *  External, so a manual twin on the same day is not a VAIG miss (issue #69). */
export function externalCoveredKeys(
  external: { client_id: string; starts_at: string }[],
): Set<string> {
  return new Set(external.map((k) => clientDayKey(k.client_id, k.starts_at)));
}

/** The local hour the LAST reminder batch fires (21:00 Montevideo evening
 *  catch-up — migration 20260821232305). The "sin recordatorio" alert gates on
 *  THIS hour: reminders go out at 16:00 AND a catch-up at 21:00, so a tomorrow
 *  session that shows up between 16:00 and 21:00 is not yet a miss (the 21:00
 *  batch will still try it). Only a null reminder AFTER the last batch is a
 *  genuine miss worth messaging by hand. (The 16:00 batch hour lives as
 *  SEND_HOUR_LOCAL in send-reminders/logic.ts — the edge function's concern.) */
export const LAST_REMINDER_BATCH_HOUR_LOCAL = 21;

/** Montevideo hour (0–23) of an instant. */
function localHour(ms: number): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Montevideo",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms)),
  );
}

/**
 * Tomorrow's (next Montevideo day) sessions whose reminder should have gone out
 * but didn't — a genuine miss, surfaced so the desk can message them by hand.
 * The agenda badge shows "pendiente" whether the reminder was sent-and-unanswered
 * OR never sent, so a failed/never-sent reminder is otherwise invisible.
 *
 * TIMING GATE (fix 2026-08-13; updated 2026-08-21 for the evening batch): the
 * reminders go out at 16:00 AND a catch-up runs at 21:00 for the whole next
 * day. Before the LAST batch (21:00) local, a tomorrow session's null reminder
 * isn't a miss — either the 16:00 batch hasn't run, or it ran before the
 * session appeared (via sync) and the 21:00 catch-up will still try it. Only
 * after 21:00 does a null reminder mean a real failure worth manual follow-up.
 *
 * External-covered and cancelled sessions are never misses. Deduped by
 * client+day+time so a client with two DB rows at the same slot appears once.
 * Uruguay has no DST (fixed -03:00).
 */
export function missedReminders(
  rows: ReminderCheckSession[],
  nowMs: number,
  externalCovered: Set<string> = new Set(),
): MissedReminder[] {
  // Before today's LAST batch (21:00), tomorrow's reminders may still go out
  // automatically (16:00 batch, or the 21:00 catch-up for sessions that
  // appeared later) — so it's not yet a miss. Nothing to alarm until then.
  if (localHour(nowMs) < LAST_REMINDER_BATCH_HOUR_LOCAL) return [];

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
  const from = new Date(`${today}T00:00:00-03:00`).getTime() + 24 * HOUR_MS;
  const to = from + 24 * HOUR_MS;
  const out: MissedReminder[] = [];
  const seen = new Set<string>(); // dedupe key: client|starts_at
  for (const r of rows) {
    if (r.reminder_sent_at) continue; // reminded → not a miss
    if (r.status !== "scheduled") continue; // cancelled/reschedule → not a miss
    if (r.source === "external") continue; // External reminds its own
    // A manual/app session whose client has a scheduled External session the
    // same Montevideo day is External-covered → its null reminder is by design.
    if (externalCovered.has(clientDayKey(r.client_id, r.starts_at))) continue;
    const at = new Date(r.starts_at).getTime();
    if (at < from || at >= to) continue;
    // Dedupe: one entry per client+slot (a client with two DB rows at the same
    // time — dirty data — must not show twice, issue reported 2026-08-13).
    const key = `${r.client_id}|${r.starts_at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: r.id, full_name: r.full_name, starts_at: r.starts_at });
  }
  return out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

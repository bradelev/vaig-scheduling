/**
 * Immediate reminder for late-created app sessions (issue #120, PRD §II.5),
 * Node side. The daily batch runs once at 16:00 MVD for the whole NEXT local
 * day; a session for tomorrow created AFTER 16:00 today falls into a 24h hole
 * and would never get its single reminder. When that's the case, fire the
 * reminder now by invoking the send-reminders edge function scoped to this one
 * session (`session_id`), which reuses the full predicate/dedup/coverage —
 * best-effort, never throws into the caller.
 *
 * NOTE: `needsImmediateReminder` mirrors the Deno-side logic in
 * supabase/functions/send-reminders/logic.ts (same name). The two can't share
 * a module across the Node/Deno boundary; they must stay in sync (a divergence
 * only mis-times a reminder, never double-sends — the dedup guards that).
 */

const HOUR_MS = 3_600_000;
const TIMEZONE = "America/Montevideo";
const SEND_HOUR_LOCAL = 16;

function localDayKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function localHour(iso: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIMEZONE,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso)),
  );
}

/** See the Deno twin's doc — true only for a tomorrow session created at/after 16:00 today. */
export function needsImmediateReminder(startsAtIso: string, now: Date): boolean {
  const nowIso = now.toISOString();
  const todayKey = localDayKey(nowIso);
  const tomorrowKey = localDayKey(
    new Date(new Date(`${todayKey}T00:00:00-03:00`).getTime() + 24 * HOUR_MS).toISOString(),
  );
  if (localDayKey(startsAtIso) !== tomorrowKey) return false;
  return localHour(nowIso) >= SEND_HOUR_LOCAL;
}

/**
 * Fire the immediate reminder for one session via the send-reminders edge
 * function. Best-effort: a failure is swallowed (the batch is the backstop for
 * anything this misses). Returns whether the call was attempted+ok.
 */
export async function sendImmediateReminder(sessionId: string): Promise<boolean> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return false;
  try {
    const res = await fetch(`${base}/functions/v1/send-reminders`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ session_id: sessionId }),
    });
    if (!res.ok) {
      console.error(`immediate reminder: send-reminders HTTP ${res.status} for session ${sessionId}`);
      return false;
    }
    // A 200 with 0 sent for an immediate call is suspicious — the session was
    // deemed eligible at CRUD time but the pipeline sent nothing (already
    // reminded is fine; anything else is a silently-missed reminder). Surface
    // it so an orphan isn't invisible (best-effort — never throws).
    const detail = await res.json().catch(() => ({}));
    if (detail?.detail?.sent === 0) {
      console.error(
        `immediate reminder: 0 sent for session ${sessionId} (candidates=${detail?.detail?.candidates})`,
      );
    }
    return true;
  } catch {
    return false;
  }
}

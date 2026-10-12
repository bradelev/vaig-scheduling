/**
 * Orchestration for send-reminders (PRD FR-2, issue E4-T2), decoupled from
 * I/O through `Deps` so the whole batch behavior is testable with fakes:
 * selection → dedup → send (one failure never aborts) → mark → job_runs.
 */
import {
  buildTemplatePayload,
  type Candidate,
  dedupeByClientDay,
  nextLocalDayWindow,
  phoneLast4,
  redactPhones,
  remindedKeys,
} from "./logic.ts";

const HOUR_MS = 3_600_000;

export type SendResult = { ok: true; wamid: string } | { ok: false; error: string };

export interface Deps {
  now(): Date;
  /**
   * FR-2 selection predicate, evaluated in the database (see index.ts).
   * `onlySessionId` (issue #120) restricts the batch to a single session for
   * the immediate reminder of a late-created session — the same predicate,
   * window, dedup and coverage apply, just scoped to one candidate.
   */
  fetchCandidates(
    fromIso: string,
    toIso: string,
    onlySessionId?: string,
  ): Promise<Candidate[]>;
  /** Sessions of these clients already reminded, inside a wide window. */
  fetchReminded(
    clientIds: string[],
    fromIso: string,
    toIso: string,
  ): Promise<{ client_id: string; starts_at: string }[]>;
  /**
   * SCHEDULED external-source sessions of these clients in the window
   * (issue #69): External reminds its own bookings, so any same-day manual
   * twin must be skipped. Cancelled external rows are excluded at the query.
   */
  fetchExternalCovered(
    clientIds: string[],
    fromIso: string,
    toIso: string,
  ): Promise<{ client_id: string; starts_at: string }[]>;
  sendTemplate(payload: Record<string, unknown>): Promise<SendResult>;
  markSent(sessionId: string, wamid: string): Promise<void>;
  startJobRun(): Promise<string>;
  finishJobRun(id: string, ok: boolean, detail: unknown): Promise<void>;
}

export type RunOutcome = { ok: boolean; detail: Record<string, unknown> };

/** Loose E.164: the rehearsal override must be unambiguously a phone. */
const E164_RE = /^\+\d{8,15}$/;

export async function runSendReminders(
  deps: Deps,
  dryRun: boolean,
  testPhoneOverride?: string,
  onlySessionId?: string,
): Promise<RunOutcome> {
  const jobId = await deps.startJobRun();
  const detail: Record<string, unknown> = { dry_run: dryRun };
  try {
    // Rehearsal mode (issue #60): a set-but-malformed override aborts BEFORE
    // any send — falling back to real client phones when the operator asked
    // for a rehearsal would be the worst possible failure mode.
    if (testPhoneOverride !== undefined) {
      if (!E164_RE.test(testPhoneOverride)) {
        throw new Error(
          `TEST_PHONE_OVERRIDE is set but not E.164 (+59898...): refusing to send`,
        );
      }
      detail.test_override = true;
    }
    // Window (issue #78): the whole NEXT Montevideo calendar day. Half-open
    // and midnight-aligned, so today's 16:00 run and tomorrow's never see
    // the same session twice.
    const { fromIso: from, toIso: to } = nextLocalDayWindow(deps.now());
    const candidates = await deps.fetchCandidates(from, to, onlySessionId);
    detail.scope = onlySessionId ? { only_session: onlySessionId } : "batch";

    // ±24h padding so every session sharing a Montevideo calendar day with a
    // candidate is visible to the dedup. The pad spans BOTH the batch window
    // AND the candidates' own range — for a single-session immediate call
    // (issue #120) the candidate may sit outside the now-derived window (a
    // late-night create), so anchoring the pad only on the window would miss
    // that day's reminded/external rows.
    const clientIds = [...new Set(candidates.map((c) => c.client_id))];
    const starts = candidates.map((c) => new Date(c.starts_at).getTime());
    const lo = Math.min(new Date(from).getTime(), ...starts);
    const hi = Math.max(new Date(to).getTime(), ...starts);
    const padFrom = new Date(lo - 24 * HOUR_MS).toISOString();
    const padTo = new Date(hi + 24 * HOUR_MS).toISOString();
    const reminded = clientIds.length
      ? await deps.fetchReminded(clientIds, padFrom, padTo)
      : [];
    // External coverage (issue #69): same padding, same day-key mechanics.
    const external = clientIds.length
      ? await deps.fetchExternalCovered(clientIds, padFrom, padTo)
      : [];
    const { toSend, skipped } = dedupeByClientDay(
      candidates,
      remindedKeys(reminded),
      remindedKeys(external),
    );

    detail.window = { from, to };
    detail.candidates = candidates.length;
    detail.skipped_dedup = skipped;
    // No full phones in job_runs — last 4 digits only.
    detail.selected = toSend.map((c) => ({
      session_id: c.id,
      client_id: c.client_id,
      starts_at: c.starts_at,
      phone_last4: phoneLast4(c.phone),
    }));

    if (dryRun) {
      detail.sent = 0;
      await deps.finishJobRun(jobId, true, detail);
      return { ok: true, detail };
    }

    const errors: Record<string, unknown>[] = [];
    let sent = 0;
    for (const c of toSend) {
      let result: SendResult;
      try {
        result = await deps.sendTemplate(buildTemplatePayload(c, testPhoneOverride));
      } catch (err) {
        errors.push({
          session_id: c.id,
          phone_last4: phoneLast4(c.phone),
          error: redactPhones(String(err)),
        });
        continue;
      }
      if (!result.ok) {
        errors.push({
          session_id: c.id,
          phone_last4: phoneLast4(c.phone),
          error: redactPhones(result.error),
        });
        continue;
      }
      sent++;
      try {
        await deps.markSent(c.id, result.wamid);
      } catch (err) {
        // The message went out but the session is still unmarked: surface it
        // loudly — without the mark, tomorrow's run would double-send.
        errors.push({
          session_id: c.id,
          phone_last4: phoneLast4(c.phone),
          wamid: result.wamid,
          error: redactPhones(`sent but failed to mark: ${String(err)}`),
        });
      }
    }

    detail.sent = sent;
    detail.errors = errors;
    const ok = errors.length === 0;
    await deps.finishJobRun(jobId, ok, detail);
    return { ok, detail };
  } catch (err) {
    detail.fatal = String(err);
    await deps.finishJobRun(jobId, false, detail);
    return { ok: false, detail };
  }
}

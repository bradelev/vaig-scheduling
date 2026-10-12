/**
 * Orchestration for send-review-requests (PRD §III, layer 3), decoupled from
 * I/O through `Deps` so the whole batch is testable with fakes:
 * select (candidates whose last session was yesterday) → dedup → send (one
 * failure never aborts) → mark client.review_requested_at → job_runs.
 *
 * Idempotency lives on the CLIENT, not the session: once asked, review_requested_at
 * is set and v_review_candidates hides the client for the 90-day grace, so a
 * re-run the same day (or a retry) never double-asks.
 */
import {
  buildReviewPayload,
  dedupeByClient,
  phoneLast4,
  type ReviewCandidate,
  redactPhones,
  yesterdayLocalDayWindow,
} from "./logic.ts";

export type SendResult =
  | { ok: true; wamid: string }
  | { ok: false; error: string };

export interface Deps {
  now(): Date;
  /**
   * Review candidates whose LAST completed session falls inside [fromIso, toIso)
   * (yesterday, Montevideo). Eligibility (3+ completed, not reviewed, not opted
   * out, outside the 90-day grace) is enforced by v_review_candidates; this adds
   * only the "asked the day after" time trigger.
   */
  fetchCandidates(fromIso: string, toIso: string): Promise<ReviewCandidate[]>;
  sendTemplate(payload: Record<string, unknown>): Promise<SendResult>;
  /** Set clients.review_requested_at = now, ONLY if still null (never re-ask). */
  markRequested(clientId: string): Promise<void>;
  startJobRun(): Promise<string>;
  finishJobRun(id: string, ok: boolean, detail: unknown): Promise<void>;
}

export type RunOutcome = { ok: boolean; detail: Record<string, unknown> };

/** Loose E.164: the rehearsal override must be unambiguously a phone. */
const E164_RE = /^\+\d{8,15}$/;

export async function runSendReviewRequests(
  deps: Deps,
  dryRun: boolean,
  testPhoneOverride?: string,
): Promise<RunOutcome> {
  const jobId = await deps.startJobRun();
  const detail: Record<string, unknown> = { dry_run: dryRun };
  try {
    // Rehearsal mode (issue #60): a set-but-malformed override aborts BEFORE
    // any send — falling back to real client phones would be the worst failure.
    if (testPhoneOverride !== undefined) {
      if (!E164_RE.test(testPhoneOverride)) {
        throw new Error(
          `TEST_PHONE_OVERRIDE is set but not E.164 (+59898...): refusing to send`,
        );
      }
      detail.test_override = true;
    }

    const { fromIso: from, toIso: to } = yesterdayLocalDayWindow(deps.now());
    const candidates = await deps.fetchCandidates(from, to);
    const { toSend, skipped } = dedupeByClient(candidates);

    detail.window = { from, to };
    detail.candidates = candidates.length;
    detail.skipped_dupe = skipped;
    // No full phones in job_runs — last 4 digits only.
    detail.selected = toSend.map((c) => ({
      client_id: c.client_id,
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
        result = await deps.sendTemplate(
          buildReviewPayload(c, testPhoneOverride),
        );
      } catch (err) {
        errors.push({
          client_id: c.client_id,
          phone_last4: phoneLast4(c.phone),
          error: redactPhones(String(err)),
        });
        continue;
      }
      if (!result.ok) {
        errors.push({
          client_id: c.client_id,
          phone_last4: phoneLast4(c.phone),
          error: redactPhones(result.error),
        });
        continue;
      }
      sent++;
      try {
        await deps.markRequested(c.client_id);
      } catch (err) {
        // The message went out but the client is unmarked: surface it loudly —
        // without the mark, a re-run could double-ask.
        errors.push({
          client_id: c.client_id,
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

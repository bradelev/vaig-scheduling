/**
 * Health/status aggregates for the review-request pipeline (2026-08-11).
 * Pure — no I/O. The /resenas page reads v_review_candidates and the latest
 * send-review-requests job_run, and these turn that into the counts staff see:
 * how many asks went out, how many failed, how many are still pending.
 */

/** One candidate row's ask state, derived from review_requested_at. */
export type ReviewAskRow = { review_requested_at: string | null };

/**
 * Pending count across the current candidate set: rows whose review_requested_at
 * is still null (never asked). A candidate re-eligible after the 90-day grace
 * reappears WITH review_requested_at set (just old), so subtracting the
 * already-asked rows leaves only the truly-never-asked as pending. The "asked"
 * count is sourced separately by the page (from clients, grace-independent).
 */
export function reviewStatusCounts(
  rows: ReviewAskRow[],
): { pending: number } {
  let asked = 0;
  for (const r of rows) if (r.review_requested_at) asked++;
  return { pending: rows.length - asked };
}

/** The last automated batch's outcome, from its job_runs row detail. */
export type ReviewRunDetail = {
  finished_at: string | null;
  ok: boolean | null;
  /** send-review-requests writes detail.sent and detail.errors[]. */
  sent?: number;
  errorCount?: number;
};

export type ReviewBatchHealth =
  | { state: "never" }
  | {
    state: "ok" | "errors";
    finished_at: string | null;
    sent: number;
    errors: number;
  };

/**
 * Health of the last automated send-review-requests run. `never` when the job
 * hasn't run yet (no cron fired, or the feature just shipped). `errors` when
 * the last run reported any failed send — that's the signal staff should act on
 * (a client who should have been asked wasn't).
 */
export function reviewBatchHealth(
  last: ReviewRunDetail | null,
): ReviewBatchHealth {
  if (!last || last.finished_at === null) return { state: "never" };
  const errors = last.errorCount ?? 0;
  return {
    state: errors > 0 || last.ok === false ? "errors" : "ok",
    finished_at: last.finished_at,
    sent: last.sent ?? 0,
    errors,
  };
}

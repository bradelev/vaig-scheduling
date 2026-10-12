# ADR-0002: Derived read models are SQL views, never stored

- **Status:** Accepted
- **Date:** 2026-07-13

## Context

The operator views need, per client, the last session, the next session, its confirmation state and days since the last visit. Storing these as columns means keeping them in sync with every sync run, edit, cancellation and reschedule.

## Decision

Last/next session and every list built on them are **SQL views** (`v_client_status`, `v_unmatched`, `v_reactivation`, `v_rebooking_past`, `v_review_candidates`), all `security_invoker` so RLS applies to the caller.

## Alternatives considered

- **Denormalized columns updated by triggers or jobs.** Rejected: "mutation management" code with no product value and a permanent source of drift.

## Consequences

- No synchronization bugs for derived data. Fixing a rule is a view change.
- `CREATE OR REPLACE VIEW` can only append columns: adding a column mid-list fails with 42P16 (caught in CI once).
- The opposite rule applies to money: see [ADR-0010](0010-stored-locked-package-balance.md).

## References

PRD §5 principle 2, §6. `supabase/migrations/20260715003154_views.sql` and later view migrations.

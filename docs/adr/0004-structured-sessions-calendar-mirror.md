# ADR-0004: Structured sessions in the app; the calendar becomes a mirror

- **Status:** Accepted
- **Date:** 2026-08-06

## Context

With v2 in production, the unmatched queue reached 244 items. Curation cost went down with tuning but never to zero, because noise depended on how each person typed each event. No matcher improvement fixes an input you don't control.

## Decision

Sessions created by staff are **created and edited in the app** as structured records (client, start, duration, service, who attends). The app writes a **mirror event** to the same shared calendar so the team keeps one agenda. For app-created sessions the database is the source of truth; edits made in the calendar are detected and surfaced, not silently accepted or reverted.

## Alternatives considered

- **Keep improving the parser and classifier.** Rejected: treats the symptom.
- **A separate calendar for app sessions.** Rejected: splits the team's agenda into three views.
- **Two-way sync.** Deferred: two editors of the same truth is where most calendar integrations break.

## Consequences

- The PRD's original "100% read-only calendar" non-goal is explicitly overridden for app-created events (PRD Part II §II.3).
- The sync now reads its own writes, which makes [ADR-0005](0005-mirror-marker-deterministic-ids.md) mandatory.
- A session created for tomorrow after the 16:00 batch would never be reminded; the CRUD therefore sends that reminder immediately (§II.5).
- Shipped in six PRs without a cutover.

## References

PRD Part II. `lib/sessions/actions.ts`, `supabase/functions/calendar-write/`.

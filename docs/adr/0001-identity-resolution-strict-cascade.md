# ADR-0001: Identity resolution with a strict matching cascade

- **Status:** Accepted
- **Date:** 2026-07-13

## Context

Sessions reached the shared Google Calendar from a third-party booking SaaS (titles like `External - Cita con <name> <phone>`, Spanish for "appointment with") and from staff typing events by hand, often with nicknames, service abbreviations and no phone. A previous system tried to automate everything around this data and collapsed. Reminders and reactivation both depend on knowing **who** each event is for.

## Decision

Treat the problem as identity resolution and match each event through a strict cascade (PRD §7):

1. **Classify** first: discard all-day events, staff availability (`Lu no`, "Lu is off") and admin chores; log a count and sample of discards.
2. **Phone**: the first phone in title or description that normalizes to a valid Uruguayan number and exists in `clients`. Every phone match also learns an alias.
3. **Alias**: a client whose alias tokens are a subset of the event tokens, only when exactly one client qualifies.
4. **Human queue** (`v_unmatched`) for everything else. A human resolution learns an alias and re-matches every queued event it fits, retroactively.

## Alternatives considered

- **Fuzzy or ML matching.** Rejected: a false positive sends a WhatsApp reminder to the wrong person. The cost of an error falls on a third party.
- **Ask staff to always type the phone.** Kept as a convention, but not relied upon: it depends on discipline nobody controls.

## Consequences

- Precision over recall: some events wait for a human. The queue peaked at 244 and was the main operating cost.
- The queue's permanence is what later motivated [ADR-0004](0004-structured-sessions-calendar-mirror.md).
- Single-token aliases are the sharpest remaining false-positive edge (tracked in `docs/TECH_DEBT.md`).

## References

PRD §1, §7. `lib/normalize.ts`, `supabase/functions/sync-calendar/`, `lib/unmatched/`.

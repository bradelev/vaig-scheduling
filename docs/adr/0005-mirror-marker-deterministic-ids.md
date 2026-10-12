# ADR-0005: Mirror events: private marker and deterministic ids

- **Status:** Accepted
- **Date:** 2026-08-07

## Context

The app writes mirror events to the same calendar the hourly sync reads. Without a reliable way to recognize them, every mirror would be ingested as a second session and reminded twice. Calendar writes can also fail or be retried.

## Decision

- Every mirror event carries `extendedProperties.private.vaigApp`. The sync's classifier discards marked events (`app_managed`).
- The event id is **derived from the session UUID**. Create is `events.insert` with that id; a 409 falls back to `events.update`.
- The mirror is best-effort and decoupled: a failed write leaves the session valid with `gcal_event_id` null ("mirror pending").
- The visible title gets a prefix and the color of who attends, for humans only.

## Alternatives considered

- **Title prefix as the marker.** Rejected: a human can edit or delete it.
- **Store-then-create with a random id.** Rejected: a retry after a timeout creates a duplicate.
- **PUT to create.** Tried and rejected in review: Google only honors a client-chosen id on `insert`, so every first write would have failed silently.

## Consequences

- Retries are harmless; a secondary `client|day` dedup in reminders covers any unmarked duplicate.
- The marker key is duplicated across two edge functions (tracked debt).

## References

PRD §II.7. `supabase/functions/calendar-write/logic.ts`, `supabase/functions/sync-calendar/`.

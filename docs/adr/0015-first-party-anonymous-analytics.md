# ADR-0015: First-party, anonymous product analytics

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

After launching online booking the team needed to know where bookings stall, which services find empty calendars, and which panel screens are used at all. The PRD forbade analytics, mostly to avoid a marketing engine and third-party tracking.

## Decision

A narrow, declared scope expansion (`docs/booking-analytics.md`):

- **Funnel events** from the booking page: an anonymous per-tab UUID in `sessionStorage`, never a phone or a name. Validated, rate limited, fire-and-forget, and safe if `crypto.randomUUID` is missing on old iOS.
- **Recovery queue:** verified phones that chose a slot and stalled. Identity comes from the JWT, the row is deleted on booking, swept after 14 days, and worked only by a human via `wa.me`.
- **Panel usage:** route names only, no person (logins are shared).
- Aggregates come from a `security invoker` RPC gated by RLS. Retention is enforced by opportunistic sweeps instead of a cron.

## Alternatives considered

- **Third-party analytics.** Rejected: cookies, data leaving the project, and a consent burden for a small clinic.
- **Automated recovery messages.** Rejected: purpose limitation under Uruguay's data-protection law (Ley 18.331) and WhatsApp number-quality risk.

## Consequences

- `no_slots_seen` became the key metric: demand that found an empty calendar is the list of staff hours to load.
- Panel usage justified moving three rarely used screens behind the Settings screen (Ajustes).

## References

`docs/booking-analytics.md`, `lib/analytics/`, `supabase/migrations/20260903011847_booking_analytics.sql`.

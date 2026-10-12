# ADR-0006: Online booking alongside the external booking app, partitioned by segment

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

Clients already booked some services through a third-party booking app ("External" in this codebase), which also writes its events to the shared calendar and sends its own reminders. VAIG had the client base, the session model and its own reminders, and the clinic wanted online booking under its own control. Real clients receive WhatsApp every day, so switching everything at once risked missed or doubled reminders and double bookings.

## Decision

Build online booking inside this repository and run it **alongside** the external app, partitioned **per segment** (a service or a professional):

- A slot belongs to exactly one system at a time. A segment handled by the external app is not offered by VAIG.
- The availability engine subtracts sessions from both sources.
- Reminder suppression for the external app's bookings is decided per segment.
- Order by risk: role-based RLS first, then the availability engine used internally, then the public page.

## Alternatives considered

- **One big switch for every service.** Rejected: irreversible on a live system.
- **Partition by date.** Rejected: both systems would still sell the same professional's hours.
- **A separate repository.** Rejected: the booking *is* `clients` + `sessions` + `staff` + the reminder pipeline.

## Consequences

- Every step is measurable (no-shows per segment) and reversible.
- While both systems run, the matching cascade for the external app's events stays.

## References

`CLAUDE.md` (approved scope expansion), `lib/booking/`, `supabase/migrations/20260826140241_availability_engine.sql`.

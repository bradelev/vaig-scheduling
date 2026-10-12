# ADR-0011: Launch online booking without a deposit

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

A deposit reduces no-shows more than a reminder does, but it is the heaviest piece of the booking project: a payment provider, a webhook, reconciliation, a new state machine and more friction for clients. It's not known whether no-shows come from people who forget (reminders fix that) or people who don't care (only a deposit fixes that).

## Decision

- Launch booking **without a deposit**, measure no-shows of the segment booked through VAIG against the rest, and add a deposit only if the data asks for it.
- If added, use bank transfer with staff verification and a 24-hour auto-release of unpaid slots. No card provider.
- Clients with package credit never pay a deposit ([ADR-0010](0010-stored-locked-package-balance.md)).

## Alternatives considered

- **Deposit at launch through a payment provider.** Rejected for now: high complexity, uncertain need, fees of 4–6% plus tax.

## Consequences

- Online booking shipped weeks earlier.
- If a deposit is ever needed, the provisional-reservation states (`pending → confirmed / expired`) work for transfers now and for a provider later.

## References

`CLAUDE.md` (approved scope expansion), `lib/packages/`.

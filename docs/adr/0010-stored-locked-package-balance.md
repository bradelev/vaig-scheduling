# ADR-0010: Prepaid packages keep a stored, locked balance

- **Status:** Accepted
- **Date:** 2026-08-30

## Context

Clients buy prepaid packages (called "cuponeras" by the clinic, e.g. 6 laser sessions). A booking with credit skips the deposit and consumes one credit. The clinic previously tracked this on paper.

## Decision

- `client_packages` stores the balance explicitly (`used_sessions`), per client and **per service**. It is never derived from counting sessions.
- Credit is taken at booking time by `take_package_credit`, which consumes or creates under an advisory lock per client and service, with `FOR UPDATE` row locks.
- Refunds happen in **one place**: a trigger on the transition to `cancelled` for future sessions. A no-show keeps the credit spent.

## Alternatives considered

- **Derive the balance from completed sessions.** Rejected: mixes services, counts by date not attendance, and can't express a refund.
- **`SKIP LOCKED`.** Rejected in review: under contention it skipped the existing package and created a phantom one.
- **Refund in app actions and in the trigger.** Rejected after it produced double refunds.

## Consequences

- Money is correct under concurrency. The rule "derive everything that is a query" ([ADR-0002](0002-derived-read-models-as-views.md)) explicitly stops at money.
- A cancelled session resurrected by a stale WhatsApp button could refund twice (tracked debt).

## References

`supabase/migrations/20260830162934_client_packages.sql`, `supabase/migrations/20260831055428_package_credit_integrity.sql`, `lib/packages/`.

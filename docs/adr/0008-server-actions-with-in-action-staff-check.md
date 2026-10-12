# ADR-0008: Server Actions for staff mutations, each re-checking the caller

- **Status:** Accepted (amended 2026-10-11)
- **Date:** 2026-07-18

## Context

Staff screens mutate production data (clients, sessions, hours, packages). Next.js Server Actions keep the service-role key on the server and remove API boilerplate. But Next dispatches an action **by id** from any route the middleware lets through, including public ones, and action ids are visible in the client bundles.

## Decision

- Staff mutations are Server Actions that use the service role **only after** `requireStaff()` validates the JWT (`getUser()`, never `getSession()`) and the allowlist, with one retry on transient auth errors.
- Read actions that run as the cookie session rely on RLS (`is_staff()`).
- Public writes go through route handlers (`app/api/**`) that take identity from the verified session, never from the body.
- `lib/auth/staff-actions-guard.test.ts` classifies every `"use server"` module as staff-only or explicitly non-staff, and asserts every staff export refuses a non-staff caller without creating a service-role client.

## Alternatives considered

- **Trust the middleware.** This was the original state for 16 actions. Found in the 2026-10-11 audit: the middleware was a single point of failure.
- **Route handlers for everything.** More boilerplate, same check needed.

## Consequences

- Defense in depth: middleware, in-action check and RLS each stop the request independently.
- A new action file fails CI until someone classifies it.

## References

`lib/auth/require-staff.ts`, `lib/auth/staff-actions-guard.test.ts`, `middleware.ts`, PR #204.

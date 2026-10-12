# ADR-0012: One Next.js app, two surfaces: route groups and a public host

- **Status:** Accepted
- **Date:** 2026-08-30

## Context

The internal staff panel and the public booking page share the domain model, the slot engine and the WhatsApp pipeline, but differ in audience, trust level, branding and performance needs. The clinic's marketing site lives in another repository.

## Decision

- One Next.js App Router app with two route groups:
  - `app/(app)` is the staff panel: allowlisted, a shared layout with nav and badge counts, inline theme tokens.
  - `app/(public)/reservar` is the booking page: anonymous until phone verification, its own layout and white-label CSS tokens.
- Middleware gates everything except the public paths.
- A public host (`PUBLIC_BOOKING_HOST`, the `reservas.` subdomain) is redirected to `/reservar` except for the booking APIs, so the subdomain never exposes the panel.
- The marketing site only links to the subdomain; it does not embed the page (framing is denied).

## Alternatives considered

- **Two apps or repositories.** Rejected: duplicates the model and deployment for a single tenant.
- **Embed booking in the marketing site.** Rejected: couples two repositories and needs framing allowances.

## Consequences

- One deployment, one set of types, shared domain logic.
- Security posture differs per group, so middleware, action guards ([ADR-0008](0008-server-actions-with-in-action-staff-check.md)) and RLS must all hold.
- The public bundle stays small: the `/reservar` first load is ~95 kB, of which 87 kB is shared framework JS.

## References

`middleware.ts`, `lib/auth/route-decision.ts`, `app/(public)/reservar/`.

# ADR-0016: Multi-tenant ready, not multi-tenant

- **Status:** Accepted
- **Date:** 2026-08-06

## Context

Other small businesses showed interest in the reminder system, and v3 was a natural moment to "build a platform". There is exactly one customer.

## Decision

Build single-tenant, with seams that make a second tenant a schema evolution rather than a rewrite:

- configuration as data (services, staff, hours, colors, priorities);
- nothing business-specific hardcoded;
- white-label tokens on the public page;
- queries written so that adding an owner filter is mechanical.

There is no `tenant_id`, tenant RLS or platform code until a second customer exists.

## Alternatives considered

- **Tenancy now.** Rejected: the multi-tenant tax is paid on every feature whether or not a second customer arrives.

## Consequences

- Features ship at single-tenant speed.
- Multi-tenant / SaaS stays out of scope until approved (`CLAUDE.md`).

## References

PRD §II.2.

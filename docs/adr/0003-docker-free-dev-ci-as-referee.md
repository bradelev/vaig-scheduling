# ADR-0003: Docker-free development; CI owns the database

- **Status:** Accepted
- **Date:** 2026-07-13

## Context

One developer, working mostly with AI coding agents in local sessions, with no Docker on the development machine. The system still depends on Postgres semantics (RLS, views, constraints, triggers, cron) that mocks cannot reproduce.

## Decision

- Locally, `npm run check` (lint, typecheck, unit tests, Deno edge-function tests) is the verdict, with no database.
- Migrations are authored blind with `supabase migration new` and never edited after merge.
- CI starts an ephemeral Supabase stack, applies every migration from zero and runs `npm run test:integration` against real Postgres.

## Alternatives considered

- **Local Supabase in Docker.** Rejected for this machine and workflow.
- **Mock the database in integration tests.** Rejected: the bugs that matter here are Postgres semantics.

## Consequences

- Fast local loop; slower feedback on SQL (a CI round).
- CI caught several bugs no local check could see: a partial unique index unusable as an `ON CONFLICT` target, a view column inserted mid-list, a FK that blocked legacy rows.
- Integration tests are written from the start for any schema change (`tests/integration/`).

## References

`CLAUDE.md` (Commands, Definition of Done), `.github/workflows/ci.yml`.

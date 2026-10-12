# ADR-0013: Build the client grid in plain React instead of a data-grid library

- **Status:** Accepted
- **Date:** 2026-08-08

## Context

The client book needed a spreadsheet-like grid with inline editing, filtering and sorting. The first implementation used `react-data-grid@7.0.0-beta.47`, the repo's first UI dependency, pinned to a beta because later versions required React 19.

## Decision

Remove the dependency and build the grid in plain React with CSS Grid and the app's own tokens.

## Alternatives considered

- **Keep fighting the library.** Four rounds of fixes failed: its `@layer` CSS lost its layout rules in the Next build, producing collapsed headers and invisible editor text that only showed up in the deployed app.
- **Another grid library.** Same risk class for a need that is small: one table, a few editable columns.

## Consequences

- Zero UI dependencies again; `/clientes` dropped from ~15.5 kB to ~3.1 kB.
- A failed save reverts only the edited field, so a concurrent edit to another field isn't lost.
- Lesson kept: diagnose styling bugs in the real deployed build, in a real browser.

## References

`app/(app)/clientes/ClientesGrid.tsx`, `docs/TECH_DEBT.md` (2026-08-08, resolved).

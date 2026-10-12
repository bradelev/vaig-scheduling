# ADR-0014: One token source per surface

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

The panel grew in two generations (v2 and v3) with their own colors, button heights and error boxes: two WhatsApp greens, local `ACCENT` constants per screen, black and blue primaries. Later the public booking page got a designed identity, and the panel looked like a different product.

## Decision

- **Panel:** `lib/ui/theme.ts` is the single source of palette and control sizing (48px controls), consumed by inline styles and shared components (`Button`, `ErrorBanner`, `OkBanner`). Contrast is checked against WCAG AA in the file itself.
- **Public page:** `app/(public)/reservar/theme.css` holds white-label CSS custom properties scoped to the route segment ("swap this block, new look"), with CSS Modules for layout.
- Both surfaces share the brand (teal and warm stone; Bricolage Grotesque and Inter Tight through `next/font`, self-hosted).

## Alternatives considered

- **Adopt Tailwind or a component library.** Rejected at this size: a migration with no user value.
- **A single CSS system for both now.** Deferred: the panel's inline-style convention predates it, and converting it is cost without product change.

## Consequences

- One edit changes a surface's look; screens can't drift on color.
- Two styling mechanisms coexist. At a larger scale this is the first thing to unify (CSS variables everywhere, components consuming them). That's the honest answer to "what would you change".
- A `<style>` child rendered on the server escaped quotes and caused a hydration mismatch that re-rendered the whole panel on every load. It's now injected with `dangerouslySetInnerHTML` (constant content only).

## References

`lib/ui/theme.ts`, `app/(public)/reservar/theme.css`, `design-system/vaig-reservas/MASTER.md`.

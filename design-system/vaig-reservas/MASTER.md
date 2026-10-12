# Design System Master File — VAIG Reservas (public booking)

> **LOGIC:** When building a page under `/reservar`, check `design-system/vaig-reservas/pages/[page-name].md` first; if it exists its rules override this file. Otherwise follow this file.

**Project:** VAIG Reservas (reservas.vaigdepilacionlaser.com)
**Direction:** "B — cálido / táctil" (approved by Braulio 2026-08-27, prototyped in the "Reservá en VAIG" artifact). White-label by tokens: `app/(public)/reservar/theme.css` is the single place to swap the look.
**Generated with:** the `ui-ux-pro-max` skill (2026-08-30) for the rules/checklist; its default palette proposal (pink + lavender, Playfair/Inter, hero + testimonials) was **rejected** as the generic AI look — the tokens below are the approved direction.

---

## Color tokens (`theme.css`)

| Role | Hex | Token |
|---|---|---|
| Brand (tints, rings, hover — never white text on it: 3.05:1) | `#16a3ad` | `--brand` |
| Brand deep (CTA, selected chips, avatars — white text 4.9:1) | `#0d7d86` | `--brand-deep` |
| Brand tint (badges, notes) | `rgba(22,163,173,.12)` | `--brand-tint` |
| Page background (warm stone) | `#efe9e2` | `--bg` |
| Card | `#fbf8f4` | `--card` |
| Card, secondary surface | `#f4efe8` | `--card-2` |
| Ink | `#33302b` | `--ink` |
| Ink soft | `#6f685d` | `--ink-soft` |
| Ink soft (all small labels: 4.8:1 on card-2) | `#6f685d` | `--ink-soft` |
| Ink faint (decorative only, 3.1:1 — never text) | `#8f8677` | `--ink-faint` |
| Line | `#e5ddd1` | `--line` |
| Danger | `#a02525` / `#fdecea` | `--danger`, `--danger-bg` |

Single theme (light) on purpose: the booking page is a short task on a phone; no dark variant.

## Typography

- Display: **Bricolage Grotesque** 600–800 (`--font-display`) — headings, prices, CTA, avatar initials.
- Body: **Inter Tight** 400–700 (`--font-body`).
- Both self-hosted through `next/font/google` in `app/(public)/reservar/layout.tsx`.
- Base 16px on inputs (no iOS zoom), 26px display headings with `text-wrap: balance`, 14px body at 1.5 line-height.

## Layout & components

- Mobile-first single column; card max-width 440px centered on ≥480px, full-bleed below.
- Top bar: back (inline, left of the logo — never over it) · brand · "Paso n de 5" pill · 4px progress track.
- Every choice is a native `<button aria-pressed>` (category chips, items, professionals, days, slots). Min 44px targets, 8px gaps.
- Radii: 18px cards / 14px controls / 999px pills. Shadows: soft card, teal glow on the primary CTA only.
- Footer CTA sticks to the bottom of the card; disabled state is flat (no glow).

## Motion

- Screen enter: 320ms fade+8px rise; progress fill 350ms; hover/pressed 150–200ms. All disabled under `prefers-reduced-motion`.

## Copy (rioplatense, voseo)

"¿Qué te hacés?", "¿Con quién?", "Elegí tu horario", "Confirmá que sos vos", "¡Listo!". Status always **"Por confirmar"** + "En cuanto el equipo la confirme, te llega el aviso por WhatsApp." "Con quien sea" assigns nobody visibly ("Con quien esté libre").

## Pre-delivery checklist (from the skill, kept)

- [x] No emoji as icons (inline SVG)
- [x] 44px targets, visible focus (`:focus-visible` ring), keyboard-operable chips
- [x] Text contrast ≥ 4.5:1 on its surface (white only on `--brand-deep`; small labels `--ink-soft`)
- [x] `inputmode` tel / numeric, `autocomplete="one-time-code"`
- [x] Step indicator + `aria-live`; headings focused on step change
- [x] `prefers-reduced-motion` respected
- [x] No horizontal scroll (day strip scrolls inside its own container)

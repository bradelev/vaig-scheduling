# Frontend architecture

How the two user-facing surfaces are built, why, and what would change at a
larger scale. Decisions referenced as ADR-NNNN live in [`docs/adr/`](../adr/).

## Surfaces and audiences

| | Staff panel `app/(app)` | Public booking `app/(public)/reservar` |
|---|---|---|
| Users | 3–7 clinic staff, mostly on the clinic's iPhone, installed as a home-screen app | Clients on their own phones, first visit often from a WhatsApp or Instagram link |
| Trust | Allowlisted staff session | Anonymous until phone verification |
| Job | Run the day: agenda, confirmations, unmatched queue, clients, hours, packages, metrics | Pick a service, a professional (or "anyone"), a slot; verify phone; book |
| Styling | Inline styles over shared tokens in `lib/ui/theme.ts` | White-label CSS custom properties (`theme.css`) + CSS Modules |
| Size (first load JS) | ~100 kB per screen, 87 kB of it shared | ~95 kB |

One Next.js 14 App Router application serves both, split by route groups and a
public host redirect (ADR-0012). There are no UI dependencies beyond React and
Next: the one data-grid library tried was removed (ADR-0013).

## Rendering model

- **Server Components by default.** Every panel page is an async Server
  Component that queries Supabase with the caller's cookie session (RLS applies)
  and passes plain data to a single client component per screen
  (`ClientTable`, `UnmatchedList`, `Horarios`, `BookingFlow`, …). Nineteen client
  components in total, each a leaf that owns interaction.
- **Dynamic rendering.** Panel pages are `force-dynamic`: the data is
  per-request and operational, so caching it would only show stale agendas.
- **Streaming the shell.** The `(app)` layout renders header and navigation
  immediately and suspends only the badge counts (`<Suspense>` around the nav
  counts). A segment-level `loading.tsx` paints a skeleton (respecting
  `prefers-reduced-motion`) on every navigation. Before this, the content area
  stayed blank on cold starts.
- **Hydration discipline.**
  - Day labels ("Hoy", "Mañana") are computed from the server clock and passed
    down, so they can't shift between server render and hydration around
    midnight.
  - A `<style>` text child was escaped differently on server and client. The
    mismatch forced a full client re-render on every load for weeks, unnoticed.
    It is now injected as constant `dangerouslySetInnerHTML`.

## Data flow and mutations

- **Reads:** Server Components → Supabase (cookie session, RLS). Lists that
  change with filters keep the filter in the URL (`?filtro=`, `?dias=`), so a
  view is linkable and survives a refresh.
- **Staff writes:** Server Actions called from client components inside
  `useTransition`, so the UI stays responsive and shows pending state. Each action:
  1. re-checks the staff session (ADR-0008);
  2. validates input;
  3. writes with the service role;
  4. returns a typed `{ ok } | { error }` union with a user-facing Spanish message
     (no exceptions across the boundary);
  5. calls `revalidatePath` for the affected screens.
- **Public writes:** route handlers under `app/api/reservar/**` and
  `app/api/client-auth/**`. Identity comes from the verified session, never
  the body. Each handler is rate limited per IP and returns `429` with
  `Retry-After`.
- **No client-side cache layer.** At this size, server-rendered data plus
  revalidation is simpler than React Query or SWR and avoids two sources of
  truth.

## The booking flow

`BookingFlow.tsx` is a five-step state machine in one client component
(service → professional → slot → phone verification → confirmation). Pure
logic lives outside React in `lib/booking/public-flow.ts`, `week-map.ts` and
`slots.ts`, and is unit-tested:

- catalog grouping and lead categories;
- the week strip and labels in `America/Montevideo`;
- slot availability, computed server-side from weekly, one-off and block rules
  minus sessions from both booking sources (ADR-0006).

Details that came from real use:

- **Week navigation.** Re-entering the slot step used to drift a week forward
  each time. It now resets to the current week on a new selection and scans
  forward to the first week with slots, with no auto-advance on manual
  navigation.
- **Phone verification in place.** Requesting a code, a resend countdown and
  verifying all happen inside the step. A returning verified client is
  recognized by name after verification only, so the page is never an oracle
  for who is a client.
- **Accessibility.**
  - The step heading receives focus on each transition, so screen readers
    announce the new screen.
  - Errors and success messages use live regions.
  - Brand colors were split into a tint (decorative, 3:1) and a deep tone that
    carries white text (4.9:1).
- **Instrumentation.** Funnel events are fire-and-forget with an anonymous
  per-tab id. `track()` must never throw, because `crypto.randomUUID` is
  missing on older iOS (ADR-0015).

## Mobile-first details that mattered

- **Login as a typed code.** The panel is installed on an iPhone home screen,
  and iOS gives standalone web apps a separate cookie store from Safari. A
  magic link logs in the wrong container; a typed code doesn't (ADR-0007). A
  PWA manifest plus `apple-*` metadata make the install feel native.
- **Speed of entry.** Creating a session had to cost less than creating a
  Google Calendar event (target under 15 seconds):
  - client typeahead with inline creation;
  - date chips ("Hoy 15:00", "Mañana 10:00") to skip the native date wheel;
  - details collapsed by default.
- **Touch targets and layout.**
  - Controls are 48 px tall, with visible `:focus-visible` rings.
  - Navigation scrolls horizontally instead of wrapping.
  - On mobile, "Nueva sesión" is a floating action button, and the content
    leaves clearance for it.
- **Fewer misclicks.** Staff came from a SaaS whose habit was "button →
  navigate". A logout button on daily screens got tapped by accident, so it
  moved to the bottom of Ajustes.

## Design tokens

Each surface has exactly one token source (ADR-0014): `lib/ui/theme.ts` for
the panel (contrast-checked in the file) and `theme.css` for the public page.
The brand is shared: teal and warm stone, with Bricolage Grotesque and Inter
Tight self-hosted through `next/font`. The consolidation pass removed per-screen
color constants and two different WhatsApp greens, and unified control heights
and feedback banners.

## Security in the browser

- No browser Supabase client and no keys in the bundle. Every query and
  mutation runs on the server.
- Response headers deny framing (clickjacking) and set `nosniff`, a strict
  referrer policy, HSTS and a minimal permissions policy (`next.config.mjs`).
- No third-party scripts or trackers.

Pending (tracked in `docs/TECH_DEBT.md`): a nonce-based script CSP and
`httpOnly` auth cookies.

## Testing the UI

Logic is pulled out of components into pure, unit-tested modules: slots,
week maps, labels, filters, form validation, action result handling. Server
Actions are tested with a mocked Supabase client, including the
authorization contract for every action module. Each UI change also needs a
clean `next build`, because type checks and unit tests don't catch Server/Client
boundary errors. Visual bugs from library CSS were diagnosed in the deployed
build with a real browser, not in dev mode.

There are no component or end-to-end browser tests. That was a deliberate
trade-off for a one-person team, and it is the first thing to add with more
people (see below).

## At a larger scale, I would change

1. **One styling system.** CSS custom properties as the only token layer,
   consumed by a small component library, used by both surfaces. Inline styles
   don't scale past one maintainer.
2. **Component and E2E tests.** Playwright on the booking flow (the revenue
   path) and on the three daily staff flows, run against preview deployments.
3. **Performance budgets in CI.** Fail the build if the public page's first
   load JS grows past a budget; track Core Web Vitals from real users with the
   first-party pipeline already in place.
4. **A nonce-based CSP** and `httpOnly` cookies, both already logged as debt.
5. **Individual staff identities.** Shared logins make audit trails and
   per-person UI state impossible.
6. **Feature flags per segment.** Online booking already rolls out segment by
   segment; flags would make the rollout a configuration change instead of a
   deploy.

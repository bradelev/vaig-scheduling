# Booking analytics, recovery queue & panel usage

**Scope note.** The original PRD §3 forbids "analytics". Braulio consciously
lifted that prohibition on 2026-09-02 for THIS design only: in-house,
anonymous instrumentation stored in the project's own Supabase — never a
third-party tracker, never cookies, never marketing automation. Same posture
as the other approved expansions in CLAUDE.md.

## What exists

### 1. Public funnel (`booking_events`) — anonymous
Fire-and-forget events from the public booking page (`BookingFlow` →
`POST /api/reservar/eventos`, per-IP rate limited, strictly validated in
`lib/analytics/events.ts`). Identity is a random browser UUID
(`sessionStorage`), NEVER a phone or a name. Events:
`page_view, service_selected, staff_selected, no_slots_seen, slot_selected,
code_requested, code_verified, reserve_ok, reserve_conflict, reserve_error` —
with service / staff / week / slot dimensions where they apply.
`no_slots_seen` is the money metric: demand that found an empty calendar,
i.e. the list of services to load staff hours for.

### 2. Recovery queue (`booking_recovery`) — identified, tiny, short-lived
"Reservas a medio camino": phone-VERIFIED visitors who chose a service+slot
and stalled. One row per phone (latest intent wins), captured by
`POST /api/reservar/interes` (identity from the session JWT, never the body),
deleted on successful reservation, swept after 14 days. Staff work it by hand
from Métricas via a prefilled `wa.me` link — **deliberately no automated
sends**: purpose-limitation (Ley 18.331) and WABA-number safety both say a
human message from the local's number, one by one, or nothing. Analytics and
recovery are separate tables so the funnel carries no identity. (Honest
caveat: a staff reader could correlate a reserve_ok event with the actual
reservation via its slot time — same trust domain, not an exposure.)

### 3. Panel usage (`panel_events`) — route names only
Which panel screens the team opens (`NavBar` pathname effect →
`POST /api/panel/uso`, staff-gated, whitelisted routes). Person-level
attribution is deliberately absent (shared team logins make it meaningless).
Drives "is this feature worth maintaining" decisions — the first application
was moving Sin identificar / Reactivación / Reseñas behind Ajustes.

## Reading it
`Ajustes → Métricas`: funnel (distinct sessions per step), unmet demand,
looked-vs-booked per service, OTP friction, browsing hours
(America/Montevideo), panel usage, and the recovery queue. Aggregates come
from the `booking_metrics(p_days)` RPC (security invoker; RLS `is_staff()`
gates the rows; anon cannot execute).

## Retention (no cron)
Opportunistic sweeps on the intake endpoints (the `rate_limit_hit` pattern):
`booking_events`/`panel_events` 180 days, `booking_recovery` 14 days.

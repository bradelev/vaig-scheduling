# PRD — VAIG v2: Schedule, Reminders & Reactivation

**Version:** 1.2 (translated to English; real calendar patterns incorporated) · **Date:** 2026-07-13 · **Owner:** Braulio · **Status:** Approved for construction

> **How to use this document with Claude Code:** this PRD lives at the repo root and is the source of truth. One task = one session / one PR. Tasks marked `[HUMAN]` are never given to Claude Code. If a task tempts you to add something outside §3 (non-goals), the answer is no.
>
> **Language note:** everything in this repo is written in English. The only Spanish is (a) end-user-facing copy — both customers (the WhatsApp template body, `wa.me` prefilled text) and the staff operator UI, since the whole team is Uruguayan — and (b) the literal patterns/stopwords that match real Spanish calendar text.

---

## 1. Context and problem

VAIG (aesthetics center, Pocitos, Montevideo) books sessions that end up in a Google Calendar from two origins:

- **External app bookings:** events formatted `External - Cita con {name} [phone]` — sometimes the phone is embedded in the title; the name is usually poorly curated. Known artifact: they end at minute :59.
- **Manual events created by employees:** they have a date and a service, but the name/phone is missing or malformed.

There is a curated database under construction of ~1,300 clients (name + phone). The v1 system (Next + Supabase + n8n + LLM bot + payments + analytics) turned out too complex to maintain and is frozen.

**The core problem is identity resolution, not automation.** Once every calendar event maps to a phone number, reminders and reactivation are trivial.

## 2. Goals

1. Single view per client: name, phone, **last session** and **next session** (always derived, never hand-edited).
2. Automatic WhatsApp reminder the day before each session (16:00 batch, issue #78), with **Confirm / Reschedule** buttons that update state without human intervention.
3. **Reactivation** list: clients with no upcoming session and >21 days since the last one, to work commercially.
4. Minimal maintenance. Total system surface: **3 tables + 1 log table, 3 SQL views, 3 edge functions, 1 page, 1 template**.

## 3. Non-goals — scope contract (3 months, no exceptions)

- ❌ Chatbot / LLM of any kind.
- ❌ Self-scheduling: **Reschedule does NOT book**; it flags state and a human offers time slots over chat. External already books.
- ❌ Writing to Google Calendar. The integration is 100% read-only.
- ❌ Payments, analytics, dashboards, campaign engine. n8n stays frozen, out of the loop.
- ❌ Fuzzy matching. A false positive sends a reminder to the wrong person; on ambiguity, manual queue.
- ❌ Direct External integration (only through its events in the calendar).
- ❌ Multi-tenant / SaaS. The schema ends up naturally ready; the product is not built now.

## 4. Users and roles

| Role | Who | What they do |
|---|---|---|
| Admin | Braulio | Deploy, configuration, credentials |
| Operator | Partner + employees | Resolves the "unmatched" queue, works reactivation, answers chats on the shop phone |

A single permission level (`staff`): 3 users via magic link with full data access. No hierarchies.

## 5. Architecture

```
Google Calendar (shared read-only with a service account)
        │  hourly sync
        ▼
┌─ Supabase ─────────────────────────────────────────┐
│  Postgres: clients / aliases / sessions / job_runs │
│  SQL views: v_client_status, v_unmatched,          │
│             v_reactivation                         │
│  pg_cron ──▶ sync-calendar (hourly)                │
│         ──▶ send-reminders (daily 16:00)           │
│  wa-webhook ◀── Confirm/Reschedule buttons         │
└────────────────────────────────────────────────────┘
        ▲                          │ template
        │ UI (Next.js, 1 page,     ▼
        │ Vercel, magic link)   WhatsApp Cloud API ──▶ client
```

**Design principles:**

1. **The calendar is the source of truth for sessions. `clients` is the source of truth for identity.** They never compete.
2. **Last/next session are not stored:** they are always-live SQL views. "Mutation management" does not exist, by design.
3. **Every inbound message that is not a button is ignored by the webhook** (200 OK, no action) and handled by a human on the shop phone.
4. Every function writes to `job_runs`; the UI shows "last sync OK hh:mm" as a health indicator.

## 6. Data model

```sql
-- migrations/0001_init.sql

create table clients (
  id                   uuid primary key default gen_random_uuid(),
  full_name            text not null,
  phone                text unique not null,          -- E.164 (+598...)
  notes                text,
  opted_out            boolean not null default false, -- do not message
  last_reactivation_at timestamptz,                   -- last reactivation contact
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table aliases (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  raw_alias    text not null,        -- normalized text as seen
  alias_tokens text[] not null,      -- tokens for subset matching
  source       text not null check (source in ('manual','phone_match','seed')),
  created_at   timestamptz not null default now(),
  unique (raw_alias)                 -- an alias cannot point to two clients
);

create table sessions (
  id               uuid primary key default gen_random_uuid(),
  gcal_event_id    text unique not null,
  client_id        uuid references clients(id),       -- NULL = unmatched
  starts_at        timestamptz not null,
  ends_at          timestamptz,
  service          text,
  raw_title        text,
  raw_description  text,
  source           text not null default 'unknown'
                   check (source in ('external','manual','unknown')),
  status           text not null default 'scheduled'
                   check (status in ('scheduled','reschedule_requested','cancelled')),
  match_method     text check (match_method in ('phone','alias','manual')),
  confirmed_at     timestamptz,
  reminder_sent_at timestamptz,
  reminder_wamid   text,             -- WhatsApp message id
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index sessions_client_starts_idx on sessions (client_id, starts_at);
create index sessions_unmatched_idx on sessions (starts_at) where client_id is null;

create table job_runs (
  id          uuid primary key default gen_random_uuid(),
  job         text not null,         -- 'sync-calendar' | 'send-reminders'
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  detail      jsonb                  -- counts, errors
);
```

```sql
-- migrations/0002_views.sql

create view v_client_status as
select
  c.id, c.full_name, c.phone, c.opted_out, c.last_reactivation_at,
  ls.last_session_at, ls.last_service,
  ns.next_session_at, ns.next_session_id, ns.next_status, ns.next_confirmed_at,
  case when ls.last_session_at is not null
       then extract(day from now() - ls.last_session_at)::int end as days_since_last
from clients c
left join lateral (
  select starts_at as last_session_at, service as last_service
  from sessions s
  where s.client_id = c.id and s.starts_at < now() and s.status <> 'cancelled'
  order by starts_at desc limit 1
) ls on true
left join lateral (
  select id as next_session_id, starts_at as next_session_at,
         status as next_status, confirmed_at as next_confirmed_at
  from sessions s
  where s.client_id = c.id and s.starts_at >= now() and s.status <> 'cancelled'
  order by starts_at asc limit 1
) ns on true;

create view v_unmatched as
select id, gcal_event_id, starts_at, service, raw_title, raw_description, source
from sessions
where client_id is null and status <> 'cancelled'
order by starts_at desc;

create view v_reactivation as
select * from v_client_status
where next_session_at is null
  and last_session_at is not null
  and days_since_last > 21          -- REACTIVATION_DAYS
  and opted_out = false
order by days_since_last asc;        -- most recent first: most recoverable
```

**RLS:** enabled on every table. Single policy: role `authenticated` (staff) full access; `anon` nothing. Edge functions and scripts use `service_role`.

## 7. Normalization and matching (exact spec)

### 7.0 Event classification (before normalizing and matching)

**Not every calendar event is a session.** The real calendar mixes client sessions with employee availability and admin chores. Rule: classify first, match later.

**Discarded (never inserted into `sessions`):**

1. All-day events (public holidays, "closed" days).
2. **Employee availability:** title matching `^{employee}\s+no\b` (real examples: `Lu no`, `iara no 3 – 9pm`, `cyn no (consultar)`, `steph no`). Constant `EMPLOYEES` in `lib/normalize.ts` with each employee's names and nicknames (cyn, lu, iara, steph, … — complete/validate in E3-T5).
3. **Admin chores:** title matching `NON_SESSION_PATTERNS` (seeded from real data — these are literal Spanish calendar patterns, keep them as-is: `^bps\b`, `^pagar\b`, `^lista\b`, `^ver si\b`, `^mandar recordatorios`, `feriado`, `cardiolog`). Configurable list; tuned with usage.

**Audit:** every run records in `job_runs.detail` the count and a sample of discarded titles, to catch false discards without polluting the queue.

**External + manual duplicates:** the same real session often exists twice in the calendar — the employee's manual event and the `External - …` event (often with a slight duration difference). **They are not deduplicated in the table:** the views tolerate them (same `max`/`min` of dates) and double sending is blocked in RF-2 by the one-reminder-per-client-per-day rule.

### 7.1 Normalization

- `normalizePhone(s)`: strip every non-digit and apply Uruguay rules →
  - `09XXXXXXXX` (9 digits with leading 0) → `+598 9XXXXXXX`
  - `9XXXXXXX` (8 digits starting with 9) → `+5989XXXXXXX`
  - `598...` → prepend `+`
  - Landlines (8 digits starting with 2–4) → `+598` + number
  - Any other length/pattern → invalid (`null`), goes to the report, never stored.
- `normalizeText(s)`: lowercase → NFD without diacritics → no punctuation → collapsed whitespace.
- `tokens(s)`: `normalizeText` split on whitespace, **minus** numeric tokens and **minus** service stopwords (constant in `lib/normalize.ts`, tunable — literal Spanish words from the real calendar, keep as-is): `masaje, masajes, sesion, laser, depilacion, limpieza, facial, corporal, perfilado, tinte, uñas, manos, pies, turno, hora, cita, sra, srta, cliente, ...` **plus employee names and nicknames** (the `EMPLOYEES` constant from §7.0) — so a title like `Uñas step` never learns "step" as a client alias.

### 7.2 Matching cascade (per event, in `sync-calendar`)

1. **Phone:** regex over `title + description`; the first phone that normalizes valid **and exists in `clients`** → match (`match_method='phone'`). Learning bonus: if the event tokens are non-empty and the alias does not exist, create an alias with `source='phone_match'`. *Every event with a phone teaches an alias for free.*
2. **Alias:** clients whose `alias_tokens ⊆ tokens(event)`. **Exactly 1** client → match (`'alias'`). **0 or more than 1** → queue.
3. **Queue:** `client_id = null`. The UI shows the ambiguous candidates from step 2 first.

### 7.3 Manual resolution (in the UI)

When resolving an event: set `client_id` + `match_method='manual'` + create an alias from the event tokens (editable before saving) + **retroactive re-match**: apply the new alias to every session still without a client. A human resolution is never repeated for the same alias.

## 8. Functional requirements

### FR-1 · `sync-calendar` (edge function, hourly)

- Rolling window: `today − 7` → `today + 45`. `backfill_days` parameter for the initial run (90).
- Upsert by `gcal_event_id`: creates or updates `starts_at`, title, description, status.
- Event cancelled in GCal → `status='cancelled'`.
- **Date change of the same event = reschedule:** if `starts_at` changed and `reminder_sent_at` was already set, reset `reminder_sent_at`, `reminder_wamid` and `confirmed_at` (new date ⇒ new reminder).
- Runs the §7.2 cascade over every session without `client_id` inside the window.
- `source`: title with `External` prefix → `'external'` (and the `External - Cita con` prefix is stripped before tokenizing); everything else → `'manual'`. The §7.0 classification runs before all of this.
- Writes `job_runs` (events seen / created / updated / matched / queued).

### FR-2 · `send-reminders` (edge function, daily 16:00 America/Montevideo)

- **Send time & window (decision Braulio 2026-07-23, issue #78):** the batch runs daily at **16:00 America/Montevideo** and covers the whole **next Montevideo calendar day** — half-open `[tomorrow 00:00, day-after 00:00)` local time. (The original rolling `now()+24h…now()+48h` window fired at a fixed hour could never catch next-morning sessions the day before.)
- Selection: `status='scheduled'` **and** `confirmed_at is null` **and** `reminder_sent_at is null` **and** `client_id not null` **and** client not `opted_out` **and** `starts_at` inside the next-local-day window above **and** `source != 'external'`.
- **External sends its own reminders (decision Braulio 2026-07-23, issue #69):** VAIG never reminds a External booking — neither the `source='external'` session itself **nor its manual twin**: if the client has a *scheduled* external session the same Montevideo calendar day, the manual candidate is skipped (`external_covers_same_day` in the audit). A *cancelled* external session covers nothing. This is source-aware selection over already-synced data — not a External integration (§3 still holds).
- **Dedup (calendar duplicates §7.0):** at most **one reminder per client per calendar day** — if the client already has another session the same day with `reminder_sent_at` set, this one is skipped without marking or sending.
- Sends the reminder template (§9.2) with quick reply buttons, payloads `CONFIRM_{session_id}` and `RESCHED_{session_id}`. Two variants (issue #75): `recordatorio_sesion` when the session has a service, `recordatorio_sesion_sin_servicio` when it does not — the generic "tratamiento" fallback is gone (decision Braulio 2026-07-23).
- Variables: first name, service (only in the with-service variant), short date and time in Montevideo tz (`mié 15/07`, `14:30` — Spanish locale output, it is customer-facing).
- Sets `reminder_sent_at` + `reminder_wamid` per item. A failure on one recipient **does not abort the batch**; it accumulates in `job_runs.detail`.
- `dry_run` mode (logs without sending) for testing.

### FR-3 · `wa-webhook` (edge function)

- **GET:** Meta verification — if `hub.verify_token == WHATSAPP_VERIFY_TOKEN`, respond with `hub.challenge` as plain text.
- **POST:** validate `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with `META_APP_SECRET`); invalid signature → 401.
- `messages[].type = 'button'`:
  - payload `CONFIRM_{id}` → `confirmed_at = now()`
  - payload `RESCHED_{id}` → `status = 'reschedule_requested'`
- Any other message or delivery status → 200 with no action (a human handles it on the shop phone).
- Respond 200 in < 5s; at this volume synchronous processing is enough.

### FR-4 · UI (Next.js, one page, three views)

- **Clients:** table over `v_client_status`; search by name/phone; next-session badge (✓ confirmed / pending / 🔁 asked to reschedule / **External** — neutral chip when a scheduled External booking shares the next session's Montevideo day, since External reminds those and VAIG never will; decision Braulio 2026-07-26, issue #89); quick filter "asked to reschedule"; health indicator (last OK `job_runs` per job, with time). The "Sin confirmar mañana" chip excludes External-covered sessions — it lists only clients VAIG asked (or will ask) to confirm. Under the next session, a discreet "luego: {weekday dd/mm}" line appears only when a booking exists on a **later Montevideo day** (issue #92, decision Braulio 2026-07-26) — its absence is the desk's rebooking cue; same-day second services and twins never count as a next visit.
- **Unmatched:** list from `v_unmatched` (raw title, date, source); searchable client dropdown with ambiguous candidates suggested on top; inline "create new client" (name + phone); saving applies §7.3 in full.
- **Reactivation:** `v_reactivation`; per row: `wa.me/{phone}` link with prefilled text (in Spanish — customer-facing) for manual contact from the phone, and a "contacted" button → `last_reactivation_at = now()`.
- Auth: Supabase email login with a 6-digit code (OTP) and an email allowlist (`STAFF_EMAILS`). Mobile-first: they use it from the shop phone — a code (not a magic link) is what keeps an iOS home-screen web app signed in (a link opens the browser, whose cookies the web-clip can't see). See docs/deploy.md §5.1.

### FR-5 · Seed

- `scripts/seed.ts`: CSV `(name, phone)` → normalize → upsert into `clients` by phone. Idempotent. Generates `seed-rejects.csv` with invalid and duplicate rows for a one-time manual correction.

## 9. Integrations, credentials and template

### 9.1 Environment variables

| Variable | Lives in | Description |
|---|---|---|
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Vercel | UI |
| `SUPABASE_SERVICE_ROLE_KEY` | Functions + scripts | RLS bypass |
| `WHATSAPP_TOKEN` | Functions | Permanent token (system user) — **reused from v1** |
| `WHATSAPP_PHONE_NUMBER_ID` | Functions | Shop number — **reused from v1** |
| `WHATSAPP_VERIFY_TOKEN` | Functions | Invented string for the GET verification |
| `META_APP_SECRET` | Functions | Webhook signature |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Functions | SA email + PEM private key (single line, `\n`-escaped) — **reused from v1** |
| `GOOGLE_CALENDAR_ID` | Functions | Shared calendar |
| `TIMEZONE` | Functions + UI | `America/Montevideo` |
| `REACTIVATION_DAYS` | DB/config | Default 21 |
| `STAFF_EMAILS` | Vercel | Allowlist, comma-separated |

### 9.2 WhatsApp template (submit to Meta — critical path)

Customer-facing copy: the template is in Spanish by design (language `es_UY`). Do not translate.

- **Name:** `recordatorio_sesion` · **Language:** `es_UY` (Spanish — Uruguay; the WhatsApp Manager UI labels it "Spanish (URY)") · **Category:** `UTILITY`
- **Body:** `Hola {{1}} 👋 Te recordamos tu sesión de {{2}} el {{3}} a las {{4}} en VAIG. ¿Nos confirmás?`
- **Buttons (quick reply):** `Confirmar` · `Reagendar` (plain text, no emojis — as approved by Meta)
- Payloads are set at send time, not in the template.
- **No-service variant (issue #75):** `recordatorio_sesion_sin_servicio` · same language/category/buttons · **Body:** `Hola {{1}} 👋 Te recordamos tu sesión el {{2}} a las {{3}} en VAIG. ¿Nos confirmás?` — used when the session has no known service (submitted 2026-07-23).

## 10. Epics and tasks

> `[CC]` = worked by Claude Code · `[HUMAN]` = done by Braulio/team · **AC** = acceptance criteria.
> Overall order: E0 → E1 → E2 → E3 → E4 → E5 → E6. **E4-T1 starts on day 0 in parallel** (Meta lead time).

### E0 — Repo foundations

- **E0-T1 `[HUMAN]`** Create GitHub repo, Vercel project, `supabase link` to the existing project, load §9.1 env vars. **AC:** `vercel dev` boots; `supabase db push` connects.
- **E0-T2 `[CC]`** Scaffold: Next 14 (App Router, TS) + `supabase-js`; structure `/app`, `/lib`, `/supabase/migrations`, `/supabase/functions`, `/scripts`; complete `.env.example`; README with local setup. **AC:** build and lint pass on a clean repo.
- **E0-T3 `[CC]`** `CLAUDE.md`: this PRD as source of truth, §3 scope contract, how to run migrations/functions/tests, one-task-one-PR convention. **AC:** exists and references the PRD.
- **E0-T4 `[CC]`** `lib/normalize.ts` (`normalizePhone`, `normalizeText`, `tokens`, stopwords) + unit tests with real Uruguayan cases (§7.1). **AC:** tests green; shareable across functions, UI and scripts.

### E1 — Data model and seed

- **E1-T1 `[CC]`** Migration `0001_init` (§6: 4 tables, indexes, RLS). **AC:** applies clean on an empty project; `anon` reads nothing; `authenticated` reads/writes everything.
- **E1-T2 `[CC]`** Migration `0002_views` (§6: 3 views). **AC:** with test data, last/next/reactivation return what is expected, including cancelled excluded.
- **E1-T3 `[HUMAN]`** Export the current curated database as CSV (name, phone).
- **E1-T4 `[CC]`** `scripts/seed.ts` (FR-5). **AC:** runs twice without duplicating; `seed-rejects.csv` lists invalid rows with a reason.

### E2 — Google Calendar sync

- **E2-T1 `[HUMAN]`** Service account in Google Cloud + Calendar API enabled + share the shop calendar **read-only** with the SA email + capture `GOOGLE_CALENDAR_ID`.
- **E2-T2 `[HUMAN]`** Export 20–30 real sample events as JSON fixtures into the repo: External, manual, **and also** `{employee} no` cases, holidays and admin chores to test §7.0. Raw JSON carries fields the UI does not show (creator, colorId, description). *Without this the parser is fiction.*
- **E2-T3 `[CC]`** `sync-calendar` edge function (full FR-1, SA JWT auth, §7.2 matching, `job_runs`) + tests against the E2-T2 fixtures. **AC:** produces the expected matches/queue over fixtures; idempotent (two runs = same state); reminder reset on date change covered by a test.
- **E2-T4 `[CC]`** Scheduling with pg_cron (hourly) + manual invocation with `backfill_days` documented in the README. **AC:** cron visible; backfill runnable with one command.
- **E2-T5 `[HUMAN]`** 90-day backfill in prod; eyeball the volume against the calendar; first pass over the queue.

### E3 — Operator UI

- **E3-T1 `[CC]`** Email code (OTP) auth + `STAFF_EMAILS` allowlist. **AC:** an email outside the list cannot get in.
- **E3-T2 `[CC]`** **Clients** view (FR-4) with search, badges and health indicator. **AC:** partial phone search works; badge reflects `confirmed_at`/`status`.
- **E3-T3 `[CC]`** **Unmatched** view with candidate dropdown, inline new client, editable alias and retroactive re-match (§7.3). **AC:** resolving one event automatically matches another pending event with the same alias (reproducible test/demo).
- **E3-T4 `[CC]`** **Reactivation** view with prefilled `wa.me` and "contacted" button. **AC:** ordered by `days_since_last` asc; the button updates and the row reflects it.
- **E3-T5 `[HUMAN]`** 30-minute session with partner + employees: resolve the real queue, tune stopwords, agree on a prospective convention (phone in the event title or description).

### E4 — Reminders

- **E4-T1 `[HUMAN]` ⚠️ DAY 0** Create and submit the §9.2 template for approval in Meta. **Critical path:** review takes hours to days; all of E4 depends on this.
- **E4-T2 `[CC]`** `send-reminders` edge function (FR-2, with `dry_run`) + daily Montevideo cron (10:00 at the time; 16:00 since #78) + `job_runs`. **AC:** dry-run logs the correct selection against test data; one send failure does not stop the batch; never doubles a reminder (constraint via `reminder_sent_at`).
- **E4-T3 `[HUMAN]`** End-to-end test with team phones (fictitious sessions) before turning it on for real clients.

### E5 — Webhook

- **E5-T1 `[CC]`** `wa-webhook` edge function (FR-3) + tests for GET verification, valid/invalid signature and both payloads. **AC:** a test button updates the right session; free-text message returns 200 with no side effects.
- **E5-T2 `[HUMAN]`** Audit what depends on the current v1 webhook (the frozen bot lived there) and **repoint the URL** in the Meta app to the new function. Verify inbound chats keep arriving on the shop phone (app/API coexistence). **AC:** button→DB flow works in prod; nothing operational from v1 broke.
- **E5-T3 `[CC]`** UI reflection: "asked to reschedule" badge + filter in Clients (no new view). **AC:** tapping Reschedule on a test phone makes it appear in the filter.

### E6 — Wrap-up and operations

- **E6-T1 `[CC]`** Operations manual in the README: what to check when something fails (`job_runs`, function logs), how to resend a single reminder, how to fix a wrong match. **AC:** a non-technical operator can follow it.
- **E6-T2 `[HUMAN]`** Go-live: crons on, one week of daily observation, §11 metrics review in week 4.

## 11. Success metrics (week-4 checkpoint)

- ≥ 80% of new sessions auto-matched (phone + alias); queue < 10 items/week and shrinking.
- ≥ 95% of reminders delivered; ≥ 50% with a button response.
- Reactivation list worked weekly (`last_reactivation_at` moving).
- Zero manual edits of derived fields — by design, they don't exist.

## 12. Risks and open decisions

| Risk | Mitigation |
|---|---|
| Calendar patterns surveyed from a single week (07/13) | E2-T2 (raw JSON fixtures) confirms fields not visible in the UI and edge cases; §7.0 lists are configurable |
| Repointing the webhook breaks v1 routing | Explicit audit in E5-T2 before touching Meta |
| Inbound messages stop reaching the shop phone | Verify app/Cloud API coexistence in E5-T2 |
| Supabase free tier pauses on inactivity | The daily cron counts as activity; if it bites, Pro plan |
| Seed CSV quality | Rejects report (E1-T4), one-time manual correction |
| Scope creep (the v1 killer) | §3 is a contract; any new idea waits 3 months |

---

# Part II — VAIG v3: Structured sessions + calendar mirror

**Added:** 2026-08-07 · **Status:** Approved for construction (first iteration) · **Owner:** Braulio

> Part I (above) remains the authoritative contract for the v2 system in production. Part II adds the v3 direction on top of it and **explicitly overrides two of Part I's non-goals and one design principle** — see §II.3. Same rules apply: one task = one session = one PR; migrations/dedup/calendar-write/timezone are architect-owned and never delegated.

## II.1 Why v3

The Google Calendar free-text event was v2's only session-ingestion path, and every bit of curation labor (the unmatched queue that peaked at 244; the ever-growing Spanish classifier; the never-populated `service`) exists to reverse-engineer identity from prose. The curation cost went down but is **permanent and uncontrollable** — it depends on who writes the event, and annotation noise always leaks back. No matching polish fixes this while a human writes free prose as the source. **v3 removes free prose as the source of truth.** This is VAIG done right; it justifies itself even if never sold to a third party.

## II.2 Goals

1. Sessions are **created and edited in the app** (structured CRUD), never parsed from calendar prose.
2. The app **writes a mirror event** to Google Calendar so the team keeps one agenda view. The calendar reflects; it does not dictate.
3. Calendar edits to mirror events are **detected and surfaced** (not silently accepted or reverted) — see §II.6.
4. **Coexistence, not replacement:** External events keep flowing through the v2 matching cascade. Nothing migrates big-bang.
5. **Multi-tenant-READY, not multi-tenant:** clean seams (config out of code, ownership-scoped queries), platform NOT built now.

## II.3 Contract changes vs Part I (declared explicitly, not slipped in)

- **Part I §3 "Writing to Google Calendar … 100% read-only" — OVERRIDDEN for app-created events.** v3 writes and manages its own mirror events. External/manual events remain read-only (the cascade never writes).
- **Part I §5 design principle "The calendar is the source of truth for sessions" — OVERRIDDEN.** In v3 the **app** is the source of truth for app-created sessions; the calendar is a mirror. `clients` remains the source of truth for identity (unchanged). External events: the calendar remains their source, via the cascade.
- **Part I §3 "Multi-tenant / SaaS" non-goal — SOFTENED to "multi-tenant-ready".** Still not building the platform; building the seams so a future tenant is not a rewrite.
- **Unchanged non-goals (still in force):** no self-scheduling / public booking; no payments; no chatbot/LLM; no fuzzy matching; no session notes / historia clínica; no settings screen this iteration.

## II.4 First-iteration scope (this is what gets built now)

| In this iteration | Deferred / discarded |
|---|---|
| Session CRUD (create/edit/move/cancel in-app) | Public booking / self-scheduling |
| Mirror write to Google Calendar (same shared calendar) | Payments / señas |
| Dedup extension (session ↔ mirror ↔ External) | Settings screen / configurable knobs |
| Immediate reminder for late-created sessions (§II.5) | Second reminder to pendientes (discarded, §II.5) |
| Detect-and-notify on calendar edits (fast-follow) | Removing the matching cascade |
| Multi-tenant-ready seams | Actual multi-tenancy (2nd tenant) |

## II.5 Reminder coverage for late-created sessions (MVP requirement)

The batch runs once at 16:00 for the *next* day. A session created for **tomorrow** *after* today's batch falls into a 24h hole and never gets its single reminder — the CRUD makes this acute. **Requirement:** when a session is created/moved via the CRUD and its batch window has already passed, fire the reminder immediately; the `client|day` dedup guards against an immediate+batch double-send. This is **coverage/correctness, not optional**. Precise definition of "window passed" is architect-owned.

*A second reminder to still-`pendiente` clients was considered and **discarded for now** (WhatsApp cost + spam/number-quality risk, worse under a shared line; "pendiente" is ambiguous). If ever revisited it belongs in the config layer, morning-of only, opt-out respected, capped. Cheaper alternative preferred: surface pendientes on "Hoy" for a human to message manually.*

## II.6 Calendar-edit handling — detect and notify

A moved/edited **mirror event** (app-created) is **detected** by the sync (reusing v2's instant-comparison `sameInstant` + `fetchExisting`), flagged `diverged`, and surfaced on the **"Hoy" screen** for a human to resolve (apply the calendar change, or restore the app's time). Neither silent-accept (reintroduces "two editors") nor silent-revert (breaks the team's calendar habit). Two exceptions: a client's WhatsApp `reschedule_requested` is **not** a divergence; **External events are never touched** by this logic.

## II.7 Same shared calendar — the mandatory consequence

v3 writes to the **same** shared calendar v2 uses (`<shared-calendar>@gmail.com`), not a separate one — External writes there too, and a separate calendar would split the agenda view. **Consequence:** the sync re-reads its own mirror events, so **every mirror event MUST carry an app-managed marker (a Google Calendar extended property, invisible to humans)**. Marked events are ignored as a session source (the DB row is authoritative); unmarked events (External/manual) route through the v2 cascade. Without this marker, mirror events double as sessions → double reminders. This makes the dedup task load-bearing.

## II.8 Calendar write access

Service account `<service-account>@<gcp-project>.iam.gserviceaccount.com` (= `GOOGLE_SERVICE_ACCOUNT_EMAIL`) **already has write access** ("Hacer cambios y ver todos los detalles") on the shared calendar — verified 2026-08-07. The only remaining change is code-level: the requested OAuth scope widens `calendar.readonly` → `calendar.events` (a one-line change during the calendar-write task). The write permission is broad (can touch any event including External's); the code only touches events it created via the marker.

## II.9 Rollout — gradual, not a cutover

App-created sessions start for a **bounded subset first** (e.g. one employee / one service), verified against real behavior (no double/missing reminders, divergence flow works), then widened. This is the coexistence safety rule: VAIG is in production with real clients receiving WhatsApp; every step is measured and reversible.

## II.10 Task breakdown (first iteration)

Critical path: **T1.1** migration (session origin + `diverged` + mirror link) → **T2.1** CRUD server actions → **T3.1** calendar write + idempotent mirror → **T3.2** dedup extension → **T3.3** immediate reminder for late-created sessions. T2.2 (the <15s create UI) runs in parallel once T2.1 exists. Detect-and-notify (T4.x) is a fast-follow. **Architect-heavy:** T1.1/T3.1/T3.2/T3.3 are non-delegable (migration, calendar-write, dedup, timing). Nothing starts until each has its own `agent:ready` issue.

## II.11 Risks (v3-specific)

| Risk | Mitigation |
|---|---|
| Cirugía on a live system (real clients get WhatsApp) | Coexistence not big-bang (§II.9); every step measured and reversible |
| Mirror event re-read as a second session → double reminders | Mandatory extended-property marker (§II.7) + `client|day` dedup (T3.2) |
| Two editors of the same truth | App is the source; calendar edits are detected-and-notified, not accepted (§II.6) |
| External still writes prose we don't control | Cascade kept for External events; not removed this iteration |
| Multi-tenant tax paid before there's a 2nd client | Ready, not realized — seams only, no platform (§II.2) |
| Scope creep back toward CRM (the v1 killer, again) | Session notes / settings / payments all explicitly deferred (§II.3) |

---

# Part III — Google review requests

**Added:** 2026-08-10 · **Status:** Approved for construction · **Owner:** Braulio

> Parts I and II remain authoritative. Part III adds one feature on top and **explicitly overrides a Part I non-goal** — see §III.2. Same rules apply: one task = one PR; migration/timezone/messaging are architect-owned.

## III.1 Why

VAIG's Google reviews are grown manually and only partially today. More reviews → better local SEO / ranking for the VAIG site. The gain is asking systematically, from clients most likely to leave a positive review.

## III.2 Contract change vs Part I (declared explicitly)

- **Part I §3 "analytics / campaign engine" non-goal — NARROWLY OVERRIDDEN for review requests only.** This is a single, targeted outbound ask reusing the existing messaging pattern (wa.me now, WhatsApp template later) — **not** a campaign engine, not analytics, not a dashboard. No new marketing surface beyond this one review ask.
- **Unchanged non-goals (still in force):** no chatbot/LLM, no self-scheduling, no payments, no fuzzy matching, no session notes, no general campaign/marketing engine.

## III.3 Eligibility — who gets asked (and who never does)

- **Loyalty, not sentiment.** Only clients with **≥ 3 completed sessions** (a completed session = `starts_at < now()`, not cancelled, not dismissed). Loyal clients skew positive on their own.
- **No review gating.** We deliberately do NOT survey first and route only happy clients to Google — that violates Google/FTC policy. Loyalty is a legitimate, policy-safe proxy.
- **Never re-ask:** excluded if already marked reviewed (`reviewed_at`, a MANUAL staff mark — Google's API never tells us who reviewed), if `opted_out` (reuse the existing flag), or if asked within the last **90 days** (grace window).

## III.4 Mechanism — phased

The design is automated; the manual screen is the interim path. The message is sent from the bot number; a client who replies (not realizing it's automated) is auto-redirected to the human WhatsApp by the existing free-text handler (issue #74), so no human-contact button is needed.

- **Layers 1–2:** a staff screen (`/resenas`) listing eligible clients, with a prefilled `wa.me` review request and two actions: "Ya reseñó" (sets `reviewed_at`) and "Ya le pedí" (sets `review_requested_at`).
- **Layer 3 (built 2026-08-11):** the `send-review-requests` edge function + a daily 13:00 Montevideo cron. It asks each candidate whose **last completed session was yesterday**, once, via `pedido_resena`. Idempotent on `review_requested_at`; a client asked stays hidden 90 days. Backlog (loyal clients whose last session predates go-live) is NOT auto-asked — worked manually from `/resenas`.
  - **[HUMAN] before enabling the cron in prod:** do one real send (`dry_run` off, `TEST_PHONE_OVERRIDE` = a Braulio phone) to confirm the static-URL-button template sends without a button param, since that can't be verified from code.

## III.5 Template (approved in Meta 2026-08-11)

Customer-facing copy (Spanish by design, `es_UY`). Do not translate. This is the approved body — `lib/reviews/review.ts` mirrors it exactly.

- **Name:** `pedido_resena` · **Language:** `es_UY` · **Category:** `MARKETING` (a review ask is promotional — NOT `UTILITY` like the reminders).
- **Body:** `Hola {{1}}, te escribimos de VAIG por la sesión de ayer. Si quedaste conforme, dejanos tu opinión en Google. Nos ayuda un montón a que la gente nos encuentre.` — `{{1}}` = first name (example: `Gabriela`).
- **Button (call-to-action, Visit website, static URL):** text `Dejar mi reseña` → `https://g.page/r/CQES5oSQeRKKEAE/review`. The link rides in the button; the manual `wa.me` path appends it to the text instead (wa.me has no buttons). A WhatsApp-link button is NOT allowed by Meta — human contact comes from the free-text redirect (§III.4), not a button.

## III.6 Data

- `clients.review_requested_at`, `clients.reviewed_at` (both timestamptz, nullable).
- View `v_review_candidates` (≥3 completed, not reviewed, not opted out, outside the 90-day grace), `security_invoker`, staff/service_role read only.
- Google review link is a public business URL (not a secret).

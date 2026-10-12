# Tech debt

### [2026-10-11] [HUMAN] Rotate the webhook verify token and shorten the staff OTP expiry
**Priority**: high
**File**: Supabase secrets, Meta app webhook settings, Supabase Auth settings (dashboard)
**Description**: The old `WHATSAPP_VERIFY_TOKEN` value lived in git history and was never rotated. It only gates Meta's subscription handshake (message authenticity is the HMAC), but it must be treated as public. Separately, the email OTP used by staff login expires after 1 hour by default; 10 minutes is enough and narrows guessing.
**Acceptance criterion**: a new random verify token set in both Supabase secrets and the Meta webhook config, and the webhook re-verified; Auth → Email OTP expiry ≤ 600 s in prod.

### [2026-10-11] Per-email staff verify limit can be used to lock a shared account out
**Priority**: low
**File**: lib/auth/actions.ts (verifyCode), lib/security/rate-limit.ts (staffVerifyEmail)
**Description**: Every verification attempt counts against the email, so someone who knows a shared staff address can spend its 15 attempts per 15 minutes and lock it out for that window. Accepted trade-off: the counter is what bounds distributed guessing of the 6-digit code, and Supabase's own verify limit already sees only Vercel's egress IP (a global lockout of the same kind exists without it). Revisit with individual staff logins or a passkey.
**Acceptance criterion**: guessing stays bounded per account while one attacker can no longer lock out staff, e.g. count only failed attempts and require a second factor after N failures.

### [2026-10-11] Auth cookies are readable by JavaScript
**Priority**: low
**File**: lib/supabase/server.ts, middleware.ts
**Description**: `@supabase/ssr` writes the session cookies without `httpOnly`. Nothing in the browser reads them (there is no browser Supabase client), so any XSS could steal a 7-day token for no benefit.
**Acceptance criterion**: cookie options set `httpOnly: true, secure: true, sameSite: "lax"`; staff and client login verified in prod after the change.

### [2026-10-11] No Content-Security-Policy beyond frame-ancestors
**Priority**: low
**File**: next.config.mjs, middleware.ts
**Description**: Security headers ship since 2026-10-11, but a script CSP needs per-request nonces for Next's inline scripts.
**Acceptance criterion**: a nonce-based `script-src` CSP on every page, with no console CSP violations on the panel and the booking flow.

### [2026-10-11] WhatsApp stub mode can silently activate in production
**Priority**: low
**File**: lib/client-auth/whatsapp.ts, lib/booking/wa-template.ts
**Description**: When `CLIENT_AUTH_TEST_MODE=1` or the WhatsApp env vars are missing, the code is logged instead of sent. It never bypasses verification, but a misconfigured prod would put login codes in Vercel logs and silently stop logins.
**Acceptance criterion**: in `VERCEL_ENV=production` the stub path throws instead of logging; covered by a test.

### [2026-10-11] Raw Postgres error messages reach the staff UI
**Priority**: low
**File**: lib/clients/actions.ts, lib/booking/hours-actions.ts (and other `No se pudo …: ${error.message}` sites)
**Description**: Database error text is returned to the browser. Staff-only today, but it leaks schema details to anyone who reaches an action.
**Acceptance criterion**: actions log the raw error server-side and return a generic Spanish message.

### [2026-10-11] Service-key bearer check in edge functions is not constant-time
**Priority**: low
**File**: supabase/functions/{send-reminders,send-review-requests,calendar-write,sync-calendar}/index.ts
**Description**: The `Authorization` bearer is compared with `!==`. A timing attack over the network is impractical, but the webhook already has a constant-time helper to reuse.
**Acceptance criterion**: all four functions compare the bearer in constant time; existing function tests stay green.

### [2026-10-11] is_staff() trusts the JWT email without checking it is verified
**Priority**: low
**File**: supabase/migrations/20260827204501_rls_by_role.sql (is_staff)
**Description**: Not exploitable today (every staff email already exists as a confirmed user), but the policy should require a confirmed email.
**Acceptance criterion**: a new migration makes `is_staff()` also require the email to be confirmed; integration test covers an unconfirmed user.

### [2026-08-31] wa-webhook RESCHED can resurrect a cancelled session
**Priority**: medium
**File**: supabase/functions/wa-webhook/index.ts (the reschedule_requested status update)
**Description**: The Reagendar button handler sets status='reschedule_requested' with no cancelled guard: a client tapping a stale reminder can flip a CANCELLED session back to life, and a later re-cancel makes the refund trigger (sessions_refund_package_credit) give the cuponera credit back a second time. Pre-existing exposure (the old app-side refund behaved identically), surfaced by the 2026-08-31 integrity review.
**Acceptance criterion**: the webhook's status update carries .neq("status", "cancelled") (plus a test), so a cancelled session can never be resurrected from a WhatsApp button.

### [2026-08-27] Date helpers in Horarios.tsx are untested (timezone-sensitive)
**Priority**: low
**File**: app/(app)/horarios/Horarios.tsx (weekdayOf, mondayOf, shiftDayKey, todayKey, dayInitial, dayMonth)
**Description**: The date-map view has Montevideo-timezone date helpers inline in the client component (weekdayOf/mondayOf added for the fixed Mon–Sun week). They're pure and timezone-sensitive — exactly the class the PRD wants unit-tested — but currently have no tests (a reviewer verified mondayOf exhaustively by hand over 400 days). They can't be imported into a vitest file from a "use client" .tsx cleanly.
**Acceptance criterion**: extract these date helpers into lib/booking/date-map.ts (or a lib/booking/date-format.ts), import them into Horarios.tsx, and add unit tests covering weekday mapping (0=Sun..6=Sat), mondayOf across weekday/Sunday/month/year boundaries, and shiftDayKey.

### [2026-08-21] Residual reminder gap: tomorrow-session appearing 21:00–23:59
**Priority**: low
**File**: supabase/functions/send-reminders/*, lib/clients/metrics.ts (missedReminders)
**Description**: The 16:00 + 21:00 batches close most of the 24h reminder hole, but a tomorrow-session that FIRST appears via the hourly sync between 21:00 and 23:59 MVD gets no reminder from either batch. Worse, `missedReminders` never surfaces it either: by the time anyone opens the agenda on the session's actual day, the session is "today", which is outside missedReminders' "tomorrow relative to now" scope — so it's a silent ~3h blind window (no send, no alert). Rare (a booking landing that late for the very next day) but real.
**Acceptance criterion**: either a third late batch (e.g. 23:30), or an immediate-reminder fired from sync-calendar when it surfaces a tomorrow-session after the last batch, or extend missedReminders to also flag today's still-un-reminded sessions in the early morning.

### [2026-08-21] Second daily trigger of send-reminders (see the concurrent-race note)
**Priority**: low
**File**: supabase/functions/send-reminders/run.ts
**Description**: The evening catch-up (migration 20260821232305) adds a SECOND daily invocation of send-reminders, which the entry below (2026-08-13, "concurrent invocations, fetch-before-mark") flags as a latent race. The two crons are 5 hours apart (16:00 and 21:00) with no realistic overlap, so this doesn't change the actual risk — noting it only because a second trigger sits on the same code path as that known debt.
**Acceptance criterion**: covered by resolving the concurrent-invocation entry below; no separate work.

### [2026-08-21] Silent 500-row cap on Reseñas lists grows misleading over time
**Priority**: low
**File**: app/(app)/resenas/page.tsx (candRes, askedRes, reviewedRes queries)
**Description**: All three clients/candidates queries cap at `.limit(500)` with no "showing N of total" indicator. The tab count badges (counts.pending/asked/reviewed) read straight off the capped array length, so once any list exceeds 500 rows the displayed count silently freezes at 500 instead of the true total. Low risk today (a boutique's history won't hit 500 soon) but the "Reseñaron" tab only grows.
**Acceptance criterion**: either paginate, or show an explicit "500+ (más no mostradas)" state distinct from the true count once a list hits the cap.

### [2026-08-19] client actions test mock ignores select() args
**Priority**: low
**File**: lib/clients/actions.test.ts
**Description**: The fake Supabase builder's `select` (and `eq`) ignore their arguments — `for (const m of ["select","eq"]) b[m] = () => b`. So the `deleteClient` tests supply `count` via the result queue and never verify the production code actually calls `.select("id", { count: "exact", head: true })` on `sessions`. If someone changed the count query to a shape that doesn't return a count (e.g. dropped `{ count: "exact" }`), the tests would still pass because the mock hands back the fixture's `count` regardless. The guard's behavior is covered (count 0/1/3 → correct outcome), but the query *shape* isn't locked in.
**Acceptance criterion**: a test asserts `deleteClient` requests `{ count: "exact", head: true }` on the sessions select (capture the select args in the mock and assert on them).

### [2026-08-16] Two unreconciled employee lists (normalize.ts vs staff.ts) — RESOLVED 2026-08-31
Resolved by the migration to the `staff` DB table + the Profesionales CRUD: `lib/sessions/staff.ts` no longer holds a hardcoded list (it queries `staff`), so there is one canonical staff source. `lib/normalize.ts` `EMPLOYEES` is a different thing — nickname stopwords for legacy calendar-text matching (§7.1), intentionally independent; a professional added via the CRUD who also loads sessions through External free text may still want her nickname added there, which is a copy-edit, not a sync problem.
**Priority**: low
**File**: lib/normalize.ts (EMPLOYEES), lib/sessions/staff.ts (STAFF)
**Description**: There are now two independent lists of "the same" employees. `lib/normalize.ts` `EMPLOYEES` (cyn, lu, iara, steph, stephy, step) is a set of nickname/variant stopwords the matcher strips from calendar free text (§7.1). `lib/sessions/staff.ts` `STAFF` (Stephany, Lu, Iara, Cyn, Joana, Angel, Leticia + colorId) is the "Quién atiende" catalog driving the calendar color. They overlap but don't match (staff.ts has Joana/Angel/Leticia; normalize.ts has spelling variants; no cross-reference). A staff member added/renamed in one but not the other silently diverges — e.g. a new employee gets a color but the matcher still doesn't strip their name from External/manual titles. Fix direction: one canonical staff source with both the matcher variants and the color, or a test asserting the two stay in sync. Not urgent — they serve different jobs and rarely change.
**Acceptance criterion**: a single source of truth for staff, or a test that fails when the two lists diverge on shared members.

### [2026-08-13] SEND_HOUR_LOCAL (16) + localHour duplicated across three files
**Priority**: low
**File**: supabase/functions/send-reminders/logic.ts, lib/sessions/immediate-reminder.ts, lib/clients/metrics.ts
**Description**: The reminder batch hour (16:00 Montevideo) and a `localHour` helper now live in three independent copies: the Deno `send-reminders/logic.ts` (SEND_HOUR_LOCAL), the Node immediate-reminder path, and the Node `missedReminders` "no aviso" gate (REMINDER_SEND_HOUR_LOCAL). Each is a deliberate, well-commented twin, but changing the batch hour requires updating all three in lockstep or the "no aviso" alert desyncs from when the batch actually runs. The Deno/Node boundary is real (can't share a module across runtimes), so full unification isn't free. Fix direction: extract one shared Node constant/helper imported by both Node call sites; leave the Deno copy as a documented manual twin (like the other cross-runtime twins).
**Acceptance criterion**: the two Node call sites import a single SEND_HOUR_LOCAL; or a test asserts the three values are equal.

### [2026-08-11] Dead code in lib/reviews after /resenas became read-only
**Priority**: low
**File**: lib/reviews/actions.ts, lib/reviews/review.ts
**Description**: When /resenas was redesigned into a read-only info board (no manual WhatsApp / "Ya reseñó" / "Ya le pedí" buttons), its Server Actions (`markReviewed`, `markReviewRequested`) and the manual-send helpers (`reviewWaLink`, `reviewMessage`, and possibly the `REVIEW_REQUEST_MESSAGE`/`GOOGLE_REVIEW_URL` re-exports) lost all callers — sending is now fully automated via the `send-review-requests` edge function, which has its OWN copy of the template constants (Deno can't import the Node lib). `grep` confirms zero non-test references. Kept for now (removing needs a careful check of what the automated path and tests still reference), but it's orphaned. Fix: delete the unused exports/files, or if a manual-send fallback is wanted, wire it back into the screen. Note the customer-facing copy now lives authoritatively in the Meta template + the edge function's logic.ts — the Node copy is not the source of truth.
**Acceptance criterion**: no unused exported symbol in lib/reviews, or a documented reason each remaining one is kept.

### [2026-08-11] Grid conversion left a few hardcoded hex colors instead of theme tokens
**Priority**: low
**File**: app/(app)/clientes/ClientesGrid.tsx, app/(app)/reactivacion/ReactivationList.tsx, app/(app)/resenas/ReviewsList.tsx, app/(app)/_components/grid.module.css
**Description**: When the three grids were converted to the shared responsive CSS module (desktop table / mobile cards), a few spots hardcode hex values (`#1a1a1a`, `#8a939c`) instead of the `INK`/`MUTED` theme tokens that are still imported and used elsewhere in the same files. The CSS module itself also hardcodes the palette (`#8a939c`, `#e2e5ea`, `#f6f7f9`…) rather than referencing the theme — acceptable since a CSS module can't import TS constants, but it means the palette now lives in two places (theme.ts + grid.module.css). Cosmetic only, no functional impact. Fix direction: use the tokens in the TSX where they're already imported; optionally expose the theme palette as CSS custom properties on a root element so the module can reference them.
**Acceptance criterion**: no raw hex in the grid TSX where a theme token exists; or a documented single source for the grid palette.

### [2026-08-10] v_review_candidates has no integration test
**Priority**: medium
**File**: supabase/migrations/20260810120000_google_review_requests.sql, tests/integration/
**Description**: The Google-reviews feature added a non-trivial view (`v_review_candidates`: a `join lateral` with `array_agg(...) filter(...)[1]`, a `>= 3` loyalty threshold, a 90-day grace boundary, RLS/grants) but no CI integration test — the DoD ("new tests for new logic") and the repo's own pattern (`tests/integration/rebooking.test.ts`, `views.test.ts`, `rls.test.ts`) call for one. The reviewer verified the SQL by trace and it's correct, and the unit tests for the copy/link logic pass, but the aggregate SQL and the appended `v_client_status` columns are unguarded against regression. Braulio chose to merge without it (2026-08-10). Also missing: unit/integration coverage for `markReviewed`/`markReviewRequested` (that RLS actually allows the staff update).
**Acceptance criterion**: an integration test covers the exactly-3-sessions boundary, the null-service-then-serviced ordering (the array_agg case), the 90-day grace boundary, and `reviewed_at`/`opted_out` exclusion; plus a test that the two Server Actions succeed under the staff RLS policy.

### [2026-08-08] service_types catalog is mirrored in two places
**Priority**: low
**File**: lib/reactivation/service-label.ts, supabase/migrations/20260807233345_v3_session_origin_diverge.sql
**Description**: The seven service categories (slug → label) are seeded in the DB (`service_types`) and mirrored as the `CATEGORY_LABEL` constant in `service-label.ts` (the reactivation copy generalizes a raw `service` to a broad category client-side, so it can't query the table per row). If a category is added/renamed in the seed and not here (or vice versa), the generalization silently misses it and falls back to the doubtful register. Currently in sync. Fix direction: either fetch `service_types` once on the Reactivación page and pass the label map into the generalizer, or add a twin-equality test that asserts the constant matches the seed INSERT (same spirit as the Node/Deno twin-equality debt).
**Acceptance criterion**: adding a category to the seed without updating the mirror is caught (by a test) or made impossible (by sourcing the labels from the DB).

### [2026-08-07] Pre-commit secret hook installed but its script isn't on main — RESOLVED
**Priority**: high
**File**: .git/hooks/pre-commit, scripts/scan-secrets.sh (missing)
**Description**: The local `.git/hooks/pre-commit` execs `scripts/scan-secrets.sh`, but that script only exists on the unmerged branch of PR #114 (`chore/secret-scanning`, still OPEN). On any branch cut from `main`, the hook aborts every commit with "No such file or directory" — the secret-scanning protection is effectively broken while also blocking normal commits. During v3-T1.1 (#115) the commit was made with `--no-verify` after a manual secret scan confirmed the files were clean; that is a stopgap, not a fix. Fix: merge PR #114 so the script lands on main (the hook then works everywhere), or point the hook at a no-op until then.
**Acceptance criterion**: a commit on a fresh branch off main runs the secret scan and passes without `--no-verify`.
**Resolution**: PR #114 merged; the hook runs on every branch.

### [2026-07-14] Next 14.2.x ships with known CVEs fixed only in Next 15
**Priority**: medium
**File**: package.json
**Description**: `next@^14.2.0` resolves to 14.2.35, which sits inside several actively tracked CVE ranges (DoS via Server Components, cache poisoning, WebSocket SSRF, XSS in CSP nonces) per `npm audit`. Fixes landed only in Next 15.x, but PRD §10 E0-T2 pins Next 14. Track new 14.2.x patch releases and revisit the PRD's Next-14 pin once the app is stable — the operator UI is behind magic-link auth, which limits exposure meanwhile.
**Acceptance criterion**: `npm audit` reports no high/critical advisories against `next`, or a documented PRD decision accepts or upgrades the pin.

### [2026-07-15] App-layer allowlist does not protect PostgREST — RESOLVED
**Priority**: high
**File**: supabase/migrations/20260714101500_init.sql (RLS policies), lib/auth/
**Description**: The STAFF_EMAILS allowlist is enforced in the Next.js layer (login action + middleware), but RLS grants blanket access to the `authenticated` role (`using (true)`). Anyone holding the anon key can call Supabase Auth directly (`shouldCreateUser` signups are on), mint an `authenticated` JWT for a non-staff email and query PostgREST, bypassing the app entirely. Not exploitable today — the anon key never ships to the browser (server-side-only design) — but every table/view the UI exposes (E3-T2/T3/T4) rides on this. Options: RLS policies that check the JWT email against staff (e.g. a `staff_emails` table or JWT claim), or disable public signups in the Supabase dashboard and pre-create the 3 staff users. Middleware is also a single point of failure (CVE-2025-29927 class — patched in the pinned 14.2.35); consider a shared `requireStaff()` re-check in data-fetching server components when the data views land.
**Acceptance criterion**: a non-staff `authenticated` JWT gets zero rows from PostgREST on every exposed table/view, verified by an integration test.
**Resolution**: 2026-08-27, migration `20260827204501_rls_by_role.sql`: every staff policy checks `is_staff()` against `staff_emails`. On 2026-10-11 every service-role Server Action also re-checks `requireStaff()`, enforced for all `"use server"` modules by `lib/auth/staff-actions-guard.test.ts`.

### [2026-07-15] send-reminders: concurrent runs could double-send
**Priority**: medium
**File**: supabase/functions/send-reminders/run.ts
**Description**: Two overlapping invocations (a manual run near the 13:00 UTC cron, or a retried cron) both fetch candidates before either marks them: both send, and `markSent`'s `.is("reminder_sent_at", null)` guard then silently updates zero rows — the double-send goes undetected. The daily cadence makes overlap unlikely, which is why this ships as-is. Fix direction: claim-before-send (`update … set reminder_sent_at = now() where id = … and reminder_sent_at is null` returning the row, send only if claimed) or a pg advisory lock around the batch.
**Acceptance criterion**: two concurrent invocations against the same seeded candidates produce exactly one send per session, verified by an integration or orchestration test.

### [2026-07-17] Single-token learned aliases are the sharpest false-positive edge
**Priority**: medium
**File**: supabase/functions/sync-calendar/logic.ts (matchEvent), lib/normalize.ts
**Description**: A learned alias with one token (e.g. "Milagros masaje" → `["milagros"]`) alias-matches any future event containing that token, for a possibly different client — unless a second such alias makes it ambiguous and queues it. This is spec-compliant (§7.2 exactly-one-subset, not fuzzy matching per §3), but it's the highest-risk path for messaging the wrong person. Revisit in E3-T5 with the team: consider a minimum-token-length guard for auto-learned (phone_match) aliases, or requiring ≥2 tokens before an alias can auto-resolve. Manual aliases (§7.3) are curated by a human and not affected.
**Acceptance criterion**: a documented decision in E3-T5 on whether single-token auto-learned aliases may resolve, and a test encoding it.

### [2026-07-17] sessions.updated_at is never bumped on update
**Priority**: low
**File**: supabase/migrations/20260714101500_init.sql
**Description**: `sessions.updated_at` (and `clients.updated_at`) default to now() on insert but have no BEFORE UPDATE trigger, so every writer (sync-calendar, send-reminders, wa-webhook confirm/reschedule) leaves updated_at stale after an update. Not user-visible today (nothing reads it), but a "last changed" column that never changes is a latent surprise for any future audit/ordering use. Fix: a shared `set_updated_at()` trigger in a new migration, applied to clients and sessions.
**Acceptance criterion**: updating any row on clients/sessions bumps updated_at, verified by an integration test.

### [2026-07-18] Clients view fetches all rows and filters in JS
**Priority**: low
**File**: app/(app)/clientas/page.tsx
**Description**: The Clients view loads every v_client_status row per page load and filters (search/quick-filter) in JS. Fine at ~1,300 clients, but it has no pagination and the payload grows linearly — it would matter at 10k+ rows. Also, the job_runs health fetch uses `order finished_at desc limit 200`; Postgres sorts NULLs first on DESC, so many null-finished (crashed/running) rows could theoretically evict a job from the window. Fix direction: push search to the query (ilike on name + digit match on phone) with server-side pagination, and filter the health query to `finished_at is not null`.
**Acceptance criterion**: the Clients view stays responsive with a seeded 10k-client dataset, verified by a query that paginates rather than fetching all rows.

### [2026-07-18] CSV parser duplicated across two Deno scripts
**Priority**: low
**File**: scripts/merge-fichas.ts, scripts/seed.ts
**Description**: The RFC-4180 CSV parser is copied in both merge-fichas.ts and seed.ts (currently byte-identical in behavior). A future edit to one and not the other could diverge and misalign name/phone columns — which would seed wrong client identities. They can't share the Node-importable seed-plan.ts cleanly (Deno-only). Fix direction: extract to a shared `scripts/csv.ts` imported by both Deno scripts once there's a third consumer, or add a golden-file test that runs both parsers over the same fixture and asserts identical output.
**Acceptance criterion**: one CSV parser implementation used by all scripts, or a test that fails if the two diverge.

### [2026-07-19] Manual resolution: single-token alias over-matches the queue
**Priority**: medium
**File**: lib/unmatched/actions.ts (resolveSession retro re-match)
**Description**: The retroactive re-match applies the operator's edited alias tokens. If a staffer trims the alias to one common token (e.g. "ana"), resolving one session assigns EVERY queued "ana …" session to that client, and future syncs learn the broad alias too. It's the intended power of an editable alias (and refused if the alias already belongs to another client — R1 guard), but there's no pre-save preview of how many sessions would be affected — the "y N más" count only appears after the write. Fix direction: show the retro-match count as a preview before the operator confirms, and/or warn when the alias has <2 tokens. Related to the auto-learned single-token alias debt (2026-07-17).
**Acceptance criterion**: the operator sees how many queued sessions an alias will resolve before confirming, or a warning when the alias is a single common token.

### [2026-07-19] firstName duplicated between lib and the reminders edge function
**Priority**: low
**File**: lib/reactivation/walink.ts, supabase/functions/send-reminders/logic.ts
**Description**: Two identical trivial `firstName` helpers exist (Next lib vs Deno edge module). No conflict today, but the greeting behavior could drift between the reactivation wa.me message and the reminder template if one is edited. Not worth coupling a Next lib to a Deno module now; consolidate if a shared pure-utils module ever emerges (same situation as the duplicated CSV parser, 2026-07-18).
**Acceptance criterion**: one shared firstName implementation, or a test asserting both produce identical output for the same inputs.

### [2026-07-22] Assert dbNotifyReschedule routing (admin ping + client ack) in a test
**Priority**: low
**File**: supabase/functions/wa-webhook/index.ts
**Description**: `dbNotifyReschedule` (issues #62/#66) constructs its own DB client and reads env directly, so the admin-ping + client-ack fan-out is not unit-tested — only the pure pieces (`ackRecipient`, copy, `handleRequest` routing) are. Consistent with the existing untested I/O boundary, but the fan-out logic (allSettled independence, override resolution wiring) could be made injectable and asserted.
**Acceptance criterion**: a fake-deps test proves a RESCHED action produces exactly one admin ping and one ack to `ackRecipient`'s output, with each failure logged and neither blocking the other.

### [2026-07-23] Idempotency for button-tap acks (double-tap → double ack)
**Priority**: low
**File**: supabase/functions/wa-webhook/index.ts
**Description**: A client double-tapping Confirmar/Reagendar (or a Meta redelivery) re-fires the ack/admin ping — no idempotency guard on the notify hooks (issues #62/#66/#68). Harmless at this volume; would need a sent-marker or dedup window to fix.
**Acceptance criterion**: a repeated CONFIRM/RESCHED for the same session within N minutes produces exactly one ack and one admin ping.

### [2026-07-23] Validate SHOP_WHATSAPP format at wiring time
**Priority**: low
**File**: supabase/functions/wa-webhook/index.ts
**Description**: The free-text redirect (issue #74) wires whenever SHOP_WHATSAPP is set, without E.164 validation (unlike TEST_PHONE_OVERRIDE). A garbage value would produce a redirect message with a broken wa.me link. Not reachable if the operator sets a real number, but inconsistent with the override's guard.
**Acceptance criterion**: a malformed SHOP_WHATSAPP leaves the feature unwired (dark) instead of sending a broken link.

### [2026-07-23] Secondary text-link buttons are sub-44px tap targets
**Priority**: low
**File**: app/(app)/sin-identificar/UnmatchedRow.tsx
**Description**: The secondary link-style buttons ("Crear clienta nueva", "descartar", "Elegir de la lista", "Cambiar" — issue #80 review NIT) all use a 13px text-link pattern with no minHeight, below the 44px touch minimum the file's inputs/buttons follow. Pre-existing convention; the team uses the app from the shop phone, so small targets cost real mis-taps.
**Acceptance criterion**: every interactive element in UnmatchedRow has an effective tap target ≥ 44px without changing the visual hierarchy.

### [2026-07-26] Precompute client name tokens in the Sin identificar render
**Priority**: low
**File**: app/(app)/sin-identificar/page.tsx
**Description**: `nameCandidatesFor` (issue #83) re-tokenizes every client full_name for every queued row (~1300 clients × up to 500 rows per server render). Fine at current staff-only traffic; wasted work if the queue grows. Precomputing `tokens(full_name)` once per render before the sessions loop removes the redundancy.
**Acceptance criterion**: client names are tokenized once per render, behavior unchanged (existing resolve.test.ts green).

### [2026-08-03] Production verify token was committed to docs/deploy.md — RESOLVED
**Priority**: high
**File**: docs/deploy.md
**Description**: `WHATSAPP_VERIFY_TOKEN='...'` (the Meta webhook GET-handshake token) was committed in plaintext, along with real IDs, the service-account email and the shop calendar id. The strong secrets (WHATSAPP_TOKEN, META_APP_SECRET, the Google private key) were correctly placeholders. Fixed forward: the doc now uses placeholders only. The verify token is low-impact (it only gates Meta's subscription handshake, not message auth — that's the HMAC signature), but it lives in git history.
**Acceptance criterion**: verify token rotated in Meta + Supabase secrets; no real secret value in any tracked file; ideally the git-history occurrence scrubbed (or accepted as low-risk given the token's limited power).
**Resolution**: 2026-10-11: no real value remains in any tracked file. The public copy of the repo is published from a history rewritten with `git filter-repo`, so the literal never reaches it. This private repo keeps its history (accepted). Rotating the token is still a [HUMAN] step, tracked in the 2026-10-11 item below.

### [2026-08-03] RLS `using(true)` — HIGH item reconfirmed by security audit — RESOLVED
**Priority**: high
**File**: supabase/migrations/20260714101500_init.sql (RLS), lib/auth/
**Description**: Re-audit of the 2026-07-15 HIGH item: the staff allowlist lives only in the Next.js layer (middleware + magic-link gate); the DB policies are `for all to authenticated using (true)`, so ANY `authenticated` JWT reads all client PII via PostgREST. Exploitable only if public sign-ups are still enabled in the prod Supabase dashboard (a human setting, not verifiable from the repo). Cheapest mitigation: confirm `enable_signup=false` in prod (drops risk to Medium). Proper fix: enforce the allowlist at the DB (e.g. an `is_staff(email)` check in the policy, or an allowlist table) so the app layer isn't the only gate.
**Acceptance criterion**: prod sign-ups confirmed disabled AND/OR the RLS policy no longer trusts every authenticated JWT.
**Resolution**: see the 2026-07-15 item: RLS by role since 2026-08-27.

### [2026-08-04] Secret-leak prevention: pre-commit scanner + CLAUDE.md rule
**Priority**: (mitigation of the 2026-08-03 leak — informational)
**File**: scripts/scan-secrets.sh, scripts/install-hooks.sh, CLAUDE.md
**Description**: Root-cause of the 2026-08-03 verify-token leak: `.gitignore` guards `.env`/`vaig-data/` (files), but a "copy-paste" deploy checklist in `docs/` put a real value in a tracked file — a place nobody associates with secrets, and one that code review / tests never scan. No pre-commit or CI secret scan existed; the only net was human judgement, which fails exactly when the file "doesn't look" sensitive.
**Mitigation shipped**: (a) CLAUDE.md rule — never write real secrets/ids/personal contacts in ANY tracked file incl. docs; use placeholders. (b) `scripts/scan-secrets.sh` — a bash-3.2/BSD-grep-portable scanner that blocks a commit adding a secret shape (sbp_/sb_/JWT/EA…/AIza/re_/PEM/verify-token), with placeholder guards to avoid false positives. Installed as a pre-commit hook via `npm run install-hooks` (auto-run on `npm install` through `prepare`). Verified: catches the exact leaked token, green on placeholders, blocks a commit end-to-end.
**Acceptance criterion**: met. Residual: the hook is local (bypassable with `--no-verify`, not on other machines) — a CI-side gitleaks/trufflehog step would be the belt-and-suspenders upgrade (owner deferred it; low incremental value for a 1-dev repo).

### [2026-08-07] Leaked verify-token literal still present in main (deploy.md + history) — RESOLVED
**Priority**: high
**File**: docs/deploy.md, docs/TECH_DEBT.md (both on main)
**Description**: When the new secret scanner (PR #114) first ran during the #114↔main merge, it flagged the literal verify token still committed in `docs/TECH_DEBT.md` AND `docs/deploy.md` on main — the 2026-08-03 "fixed forward" cleanup documented the incident but left the actual token string in tracked docs (2 occurrences on main). Replaced with a placeholder in TECH_DEBT.md as part of this merge; `docs/deploy.md` on main still carries the literal and must be scrubbed separately. The value also lives in git history regardless. Low-impact token (gates only Meta's subscription handshake, not message auth), but a real secret in tracked files is exactly what the scanner exists to stop.
**Acceptance criterion**: the leaked verify-token literal is gone from every tracked file (scrub deploy.md to a placeholder); verify token rotated in Meta + Supabase; accept the git-history occurrence as low-risk or scrub it.
**Resolution**: same as the 2026-08-03 item: scrubbed from the tree on 2026-10-11; rotation tracked below.

### [2026-08-07] Inline-client conflict/reuse/create logic duplicated — RESOLVED
**Priority**: ~~low~~ resolved 2026-08-08
**File**: lib/clients/upsert.ts (findOrCreateClient), lib/supabase/service.ts
**Description**: RESOLVED by the Frankenstein-consolidation refactor (R1). All three creation paths (createSession inline, createClientAndResolve, and the edit-path uniqueness check) now go through `lib/clients/upsert.ts`: `findOrCreateClient` (one conflict/reuse/create + one error string), `assertPhoneFree` (edit path), and `newClientDecision` moved here (re-exported from resolve.ts for back-compat). `serviceClient()` (was copied 3×) moved to `lib/supabase/service.ts`. Also fixed the observable drift: `is_first_visit` is now set on the Sin-identificar create path too (with a "Primera vez" checkbox). Tested in `lib/clients/upsert.test.ts`.
**Acceptance criterion**: met — one implementation, used by all paths, tested.

### [2026-08-07] No past-date guard on session create/move (deferred to UI)
**Priority**: low
**File**: lib/sessions/actions.ts (createSession, moveSession)
**Description**: Neither action rejects a startsAt in the past. Deferred by design to the create/move UI (T2.2, #117) — admin corrections may legitimately need to backdate, so the data layer stays permissive. Recorded so the decision is explicit, not silent.
**Acceptance criterion**: T2.2 either warns/blocks past dates in the UI, or a documented decision that backdating is allowed.

### [2026-08-07] APP_MARKER_KEY/VALUE duplicated across two edge functions
**Priority**: low
**File**: supabase/functions/calendar-write/logic.ts, supabase/functions/sync-calendar/logic.ts
**Description**: The mirror ownership marker (`vaigApp` = `"1"`) is defined as literal constants in BOTH calendar-write/logic.ts (which writes it) and sync-calendar/logic.ts (which reads it to skip app-managed events, #118/#119). If the two ever drift — someone changes the key/value in one file — the marker-based double-ingest defense silently breaks, and each file's tests use its own local constant so nothing cross-checks them. Deno edge functions can't easily share a module across function dirs (each deploys independently), which is why they're duplicated. Fix direction: a shared `_shared/` constant both import, or a test that asserts the two literals are equal.
**Acceptance criterion**: one source of truth for the marker key/value, or a test that fails if the writer's and reader's marker constants diverge.

### [2026-08-08] No link INTO the edit-session screen yet
**Priority**: medium
**File**: app/(app)/nueva-sesion/[id]/editar/, app/(app)/clientas/
**Description**: The edit screen (`/nueva-sesion/[id]/editar`, #117) works and is reachable by direct URL, but nothing links to it — a staffer can create sessions but has no button to open one for edit/move/cancel. The link belongs on wherever app-origin sessions are listed (the clientas/agenda view), which needs those sessions surfaced first (they currently show via v_client_status like any session, without an edit affordance). Fix: add an "editar" link on app-origin (source='app') sessions in the agenda/clientas view once that view distinguishes them.
**Acceptance criterion**: a staffer can reach the edit screen for an app-created session from the UI without typing a URL.

### [2026-08-08] Date quick-picks can produce a past datetime
**Priority**: low
**File**: app/(app)/nueva-sesion/NuevaSesion.tsx
**Description**: The "Hoy 15:00 / Mañana 10:00 / Mañana 15:00" quick-pick chips (#117 polish) compute a fixed local time; tapping "Hoy 15:00" after 15:00 produces a past startsAt. Neither the client nor createSession validates against the past (pre-existing — the raw datetime-local already allowed it), so a past session is created silently (the immediate-reminder path just doesn't fire for it). Product decision needed: hide/disable a chip whose time already passed today, or accept backdated sessions (staff correcting after the fact). Related to the deferred "no past-date guard" item (2026-08-07).
**Acceptance criterion**: a past-dated quick-pick is either prevented in the UI, or a documented decision that backdating is intentional.

### [2026-08-08] react-data-grid pinned to a pre-1.0 beta (React-18 ceiling) — RESOLVED
**Priority**: ~~low~~ resolved 2026-08-08
**File**: package.json, app/(app)/clientes/ClientesGrid.tsx
**Description**: The Clientes grid (#128) was the repo's first UI dependency: `react-data-grid@7.0.0-beta.47`. After 4 rounds of fighting its @layer CSS (which Next's build stripped the layout rules from — invisible editor text, collapsed headers), it never looked professional. **Resolved by removing the dependency entirely and rebuilding the grid in plain React** (CSS Grid + the app's own palette). Repo is back to zero UI dependencies; bundle for /clientes dropped ~15.5kB→3.1kB. No stability/React-19 ceiling to track anymore.
**Acceptance criterion**: met — no data-grid dependency; grid is hand-built and matches the app's styling.

### [2026-08-08] [HUMAN] Make staff sessions long-lived (Supabase dashboard)
**Priority**: medium (login UX — staff didn't want to re-login often)
**File**: (external — Supabase dashboard) + supabase/config.toml (jwt_expiry)
**Description**: Braulio wants the magic-link session to last as long as possible so the team rarely sees the login. The prod session lifetime is a DASHBOARD setting, not code: Supabase → Authentication → Sessions → leave "Time-box user sessions" and "Inactivity timeout" EMPTY/disabled → the session never expires by time or inactivity (the middleware's getUser() refreshes it on every visit, keeping the refresh token alive while the app is used). config.toml's jwt_expiry was raised to the 1-week max (604800) but that only affects the local/CI stack. This replaces the discarded Google-login idea (PR #135, closed) — chosen because it needs no console setup and no passwords (which the agent can't implement).
**Acceptance criterion**: a staff member logs in once and is not asked to re-authenticate for months of normal use; confirmed by the dashboard time-box/inactivity settings being empty.

### [2026-08-08] [HUMAN] Magic-link login on Vercel preview deploys (Supabase dashboard)
**Priority**: medium (blocks testing internal screens on preview URLs)
**File**: (external — Supabase dashboard)
**Description**: The magic link never completes on Vercel preview deploys because every preview gets a fresh URL (`https://vaig-automation-<hash>-bradelevs-projects.vercel.app`) and Supabase Auth only redirects to URLs on its allowlist — the ephemeral preview URL is never on it, so the link bounces. The code is fine: `emailRedirectTo` already uses the request's own origin (`lib/auth/actions.ts`), `/auth/confirm` redirects back to the request origin, and middleware leaves `/auth/*` public. The missing piece is the allowlist. Fix (one time): Supabase → Authentication → URL Configuration → Redirect URLs → add the wildcard `https://vaig-automation-*-bradelevs-projects.vercel.app/**` (the `*` covers the per-deploy hash + `git-<branch>` previews, `**` covers any path). Keep Site URL = the prod domain so unmatched redirects fall back to prod, not a preview.
**Acceptance criterion**: requesting a magic link from a preview URL logs you into that same preview; no code change needed.


### [2026-08-29] Never-confirmed public reservations whose date passes count as attended sessions
**Priority**: medium
**File**: supabase/migrations/20260829211201_pending_confirmation.sql, lib/booking/reserve-ports.ts
**Description**: A public reservation is born `pending_confirmation = true` (status `scheduled`). If staff never confirm nor cancel it and its date passes, `v_client_status` / `v_review_candidates` count it like any past non-cancelled session (`starts_at < now() and status <> 'cancelled'`): it feeds the loyalty threshold and can trigger a review request for a visit that may not have happened. The "por confirmar" panel surfaces stale pending rows ("Vencida", cancel only) so the team can act, but nothing cancels them automatically: a sweep (cron or on-read) should cancel pending reservations once their start time is past (or N hours before), notifying nobody.
**Acceptance criterion**: a pending reservation whose start time has passed is never counted as an attended session and is not eligible for a review request.

### [2026-08-30] Calendar-side cancellation of a cuponera session doesn't return the credit
**Priority**: low
**File**: supabase/functions/sync-calendar/index.ts (cancelExisting), lib/sessions/actions.ts (returnPackageCredit)
**Description**: When a mirrored app session's Google event is deleted, sync-calendar flips the row to cancelled directly, bypassing the app's returnPackageCredit (future session → credit back). The team can press +1 in /cuponeras, but the rule should be one: move the "future → refund" decision into a DB trigger on sessions.status → cancelled (package_id set, starts_at > now) so every cancellation path behaves the same.
**Acceptance criterion**: deleting the calendar event of a future cuponera session returns its credit without manual action.

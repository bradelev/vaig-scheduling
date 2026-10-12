# Deploy (human-only)

Deploying is a **human task** — never run by the agent (see CLAUDE.md "Prod
is human"). This is the ordered checklist to promote `main` to production.
All commands run from the repo root; `supabase` is a devDependency, so prefix
with `npx`.

Values referenced below live in your local `.env` (gitignored). Never paste
secrets into commits, issues, or the chat.

## 0. One-time auth

The interactive browser login does not work in a non-TTY shell — use a
personal access token from https://supabase.com/dashboard/account/tokens
(starts with `sbp_`). Treat it like a password; revoke it if it leaks.

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...
npx supabase link --project-ref <project-ref>
# link prompts for the database password (Settings → Database)
```

## 1. Apply migrations

```bash
npx supabase db push
```

Review the list before confirming — it must be exactly (in order):

1. `20260714101500_init` — tables + RLS
2. `20260715003154_views` — the 3 SQL views
3. `20260715034750_cron_send_reminders` — daily reminders cron (10:00; superseded by 8)
4. `20260717200449_cron_sync_calendar` — hourly sync cron
5. `20260719173733_dismissed_sessions` — unmatched dismissals
6. `20260720013838_reactivation_outcome` — reactivation contact outcomes
7. `20260723044420_bot_autoreplies` — free-text redirect rate-limit state
8. `20260724004013_reschedule_send_reminders_16h` — reminders cron moved to 16:00

…plus the later feature migrations (dismiss, reactivation outcome, reviews,
session origin, etc.) and:

- `20260821232305_evening_reminder_catchup` — **second reminders cron at 21:00
  MVD** (a catch-up for tomorrow-sessions that appear via sync after 16:00; the
  batch is idempotent so it can't double-send). Reuses the same Vault secrets
  (`project_url`, `service_role_key`) as the 16:00 cron — nothing new to set.
  After applying, `select jobname, schedule from cron.job;` should list both
  `send-reminders-daily` (`0 19 * * *`) and `send-reminders-evening`
  (`0 0 * * *`).

**If a cron migration fails with "extension pg_cron/pg_net not available":**
enable them in the dashboard (Database → Extensions), then re-run `db push`.

## 2. Function secrets

The edge functions read these from Supabase secrets (not from Vercel). Take
the values from your local `.env`:

All values come from your local `.env` — **never paste real values into this
doc or any commit** (it's tracked in git). Placeholders only:

```bash
npx supabase secrets set \
  WHATSAPP_TOKEN='...' \
  WHATSAPP_PHONE_NUMBER_ID='...' \
  WHATSAPP_VERIFY_TOKEN='...' \
  META_APP_SECRET='...' \
  GOOGLE_SERVICE_ACCOUNT_EMAIL='...' \
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n...' \
  GOOGLE_CALENDAR_ID='...'
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically into
deployed functions — do not set them here.

Operational notifications (E6-T3) — add the contacts and the email key
(all optional; a missing var silently disables that channel):

```bash
npx supabase secrets set \
  NOTIFY_ADMIN_PHONE='+598...' NOTIFY_ADMIN_EMAIL='...' \
  NOTIFY_TECH_PHONE='+598...' NOTIFY_TECH_EMAIL='...' \
  RESEND_API_KEY='re_...' NOTIFY_EMAIL_FROM='VAIG <onboarding@resend.dev>'
```

WhatsApp notifications need the `resumen_recordatorios` and
`alerta_sistema` templates APPROVED in Meta (submitted 2026-07-20).
Custom email sender requires verifying the domain in Resend first.

## 3. Deploy the functions

```bash
npx supabase functions deploy sync-calendar
npx supabase functions deploy send-reminders
npx supabase functions deploy wa-webhook
npx supabase functions deploy calendar-write        # v3 — the calendar mirror
npx supabase functions deploy send-review-requests  # v3 — automated review asks
```

> **`calendar-write` and `send-review-requests` are v3 additions.** If they were
> never deployed, the calendar mirror silently fails (every app-created session
> gets `gcal_event_id NULL` and no calendar event) and the automated review ask
> never runs. Deploy both; they reuse the SAME `GOOGLE_*` / `WHATSAPP_*` secrets
> already set for the v2 functions (nothing new to configure — the review SA
> write scope was already granted). After deploying `calendar-write`, create a
> test session in the app: the amber "no se pudo escribir en Google Calendar"
> warning should stop and the event should appear on the calendar.

### 3.1 Staff phones (for upcoming staff notifications)

Employees now live in the `staff` table (id, name, phone, color_id). The phone
column is empty until loaded by hand: Table Editor → `staff` → set `phone` per
row in E.164 (`+598…`). **Real phones are never committed** — they live only in
prod. (Staff WhatsApp notifications — the day-before summary and the
"confirmed" heads-up — are separate follow-up PRs; they'll use these phones.)

## 4. Vault secrets (for the cron jobs)

The pg_cron jobs call the functions using two Vault secrets. Create them in
the dashboard SQL editor (Database → SQL) — the service role key is the one
under Settings → API:

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<service-role-key>', 'service_role_key');
```

## 5. Auth configuration (for the code login)

In the dashboard → Authentication → URL Configuration:

- **Site URL**: `https://vaig-automation.vercel.app`
- **Redirect URLs**: add `https://vaig-automation.vercel.app/auth/confirm`
  (exact, no wildcards) — still used by any leftover magic link.

Then, in Authentication → Providers/Sign-in:

- Have each of the 4 staff accounts sign in once (they'll get a code) to create
  their user, **then** disable public sign-ups (see the #3 hardening note:
  the allowlist is app-layer, so open sign-ups widen the PostgREST surface).

### 5.1 Email a CODE, not a link (the login the app now uses)

The app logs in with a **6-digit code** the user types in, not a magic link.
This is deliberate: on an iOS home-screen web app (standalone web-clip), a magic
link opens the DEFAULT BROWSER, not the web-clip — and the two have separate
cookie stores, so the session lands in the browser and the web-clip stays logged
out. A code the user reads in Mail and types back into the app keeps the whole
login inside the same container. (It also fixes the old cross-device "el enlace
venció" PKCE problem, since there's no link/verifier at all.)

`signInWithOtp` decides link-vs-code **from the email template**: a template with
`{{ .Token }}` sends a code; one with `{{ .ConfirmationURL }}` sends a link.

**Fix (dashboard — editing the template needs custom SMTP, the default SMTP
locks the templates):**
1. **Custom SMTP** — Authentication → Emails → SMTP Settings → Enable, using
   the already-verified Resend domain (`contacto.vaigdepilacionlaser.com`):
   - Host `smtp.resend.com` · Port `465` · Username `resend` · Password =
     `RESEND_API_KEY` · Sender `login@contacto.vaigdepilacionlaser.com` ·
     Sender name `VAIG`. (Resend is already used for notifications.)
2. **Edit the template** (now unlocked) — Authentication → Emails →
   "Magic Link" → Body (Source tab). Make the body show the CODE, e.g.:
   ```html
   <h2>Tu código para entrar a VAIG</h2>
   <p style="font-size:28px;font-weight:700;letter-spacing:4px">{{ .Token }}</p>
   <p>Escribilo en la app. Vence en unos minutos.</p>
   ```
   The key is `{{ .Token }}` (the code) — do NOT include `{{ .ConfirmationURL }}`,
   or Supabase sends a link instead.
3. **Verify:** request a code on the phone's home-screen app, read it in Mail,
   type it back into the app — it signs in, and STAYS signed in (see §5.2).

### 5.2 Staying signed in (no recurring login)

Once logged in **inside** the home-screen app (via the code), the session
persists: Supabase's cookies are HttpOnly/server-set, which iOS does NOT evict
(the 7-day cap is only for JS-written cookies), the middleware refreshes the
token on every visit, and the Supabase session settings are already permissive:
- **Authentication → Sessions → Time-box user sessions = 0 (never)** — verified.
- **Inactivity timeout = 0 (never)** — verified. (Both are Pro-Plan-only to
  edit, but they're already at the values we want.)
- **Access token expiry = 3600s (1h)** — fine; the middleware auto-refreshes it.

So: log in once with the code → stays signed in indefinitely for anyone who
opens VAIG regularly.

## 6. Meta webhook (E5-T2, separate task)

Point the WhatsApp webhook to the deployed function URL
`https://<project-ref>.supabase.co/functions/v1/wa-webhook` with the
verify token `<WHATSAPP_VERIFY_TOKEN>`. Audit the v1 webhook first (#25).

## 7. Backfill (one-time, after functions are live)

Seed the first 90 days of calendar history:

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/sync-calendar" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"backfill_days": 90}'
```

Idempotent — safe to repeat. Writes a `job_runs` row with the counts.

## 8. Rehearsal mode & go-live (issue #60)

Full-pipeline test without contacting a single client: every reminder send
is redirected to a test phone (Braulio's — per the testing rule, only his
accounts ever receive test messages).

### Arm the rehearsal

If the daily cron is still scheduled, unschedule it first so no batch fires
mid-rehearsal (`select cron.unschedule('send-reminders-daily');` in the SQL
Editor), then:

```bash
npx supabase secrets set TEST_PHONE_OVERRIDE='+598<test-phone>'
# optional: receive the "admin" daily summary yourself during the rehearsal
npx supabase secrets set NOTIFY_ADMIN_PHONE='+598<test-phone>' NOTIFY_ADMIN_EMAIL='<admin-email>'
```

Trigger a real (non-dry) batch; the reminder for the real upcoming session
arrives on the test phone with live buttons. Tap **Confirmar** → the webhook
sets `confirmed_at` on the real session → visible in the app. `job_runs`
rows carry `test_override: true` so rehearsals never masquerade as real
batches.

### Clean up after the rehearsal

The rehearsal marks the REAL session (that is the point — it is faithful),
so reset it before go-live; the client never actually confirmed:

```sql
update sessions
set reminder_sent_at = null, reminder_wamid = null, confirmed_at = null
where id in (select id from sessions where reminder_wamid is not null
             and starts_at > now());  -- review the list first
```

### Go-live checklist

1. `npx supabase secrets unset TEST_PHONE_OVERRIDE` — **mandatory**.
2. Restore the real admin contacts (`NOTIFY_ADMIN_PHONE/EMAIL` → Cynthia).
3. Reset the rehearsed session(s) with the SQL above.
4. Re-schedule the daily cron (it was unscheduled while testing) —
   `npx supabase db push` applies migration
   `20260724004013_reschedule_send_reminders_16h`, which schedules
   `send-reminders-daily` at 16:00 Montevideo. If that migration is already
   applied, run its `cron.schedule('send-reminders-daily', …)` statement in
   the SQL Editor instead.

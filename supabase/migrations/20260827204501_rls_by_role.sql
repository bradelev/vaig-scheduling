-- rls_by_role (2026-08-27): Phase 0 of the public-booking plan
-- (the internal booking plan). Replace the blanket
-- `for all to authenticated using(true)` policies with STAFF-AWARE policies,
-- BEFORE any public/client login exists — so a future client JWT (Phase 1
-- phone-login) can never read the whole client PII base.
--
-- WHY THIS IS SAFE FOR THE APP TODAY:
--   * Every operationally-critical write (calendar sync, reminders, session
--     creation, the Clientes grid) runs as SERVICE_ROLE, which BYPASSES RLS.
--   * `supabase db push` connects as owner, also bypassing RLS — a wrong policy
--     cannot lock out migrations or the automation.
--   * BUT a real part of the staff UI reads/writes as the STAFF COOKIE CLIENT
--     (an `authenticated` JWT): the Clientes grid, Reactivación, Reseñas,
--     Sin-identificar, Horarios, Nueva sesión. Those relied on `using(true)`.
--     So the new predicate MUST return true for a logged-in staff email, or
--     those pages break (their "no se pudieron cargar" banners; automation and
--     the app shell keep working). The is_staff() function below is that
--     predicate, and the CI integration test asserts the positive staff path.
--
-- WHAT THIS DOES NOT DO (deliberately, per the plan):
--   * No anon-read of the catalog yet — nothing anonymous connects in Phase 0.
--     The public page's anon SELECT policies + column-scoped grants land in
--     Phase 2, additively (separate `public_read` policies), without touching
--     the staff policies below.
--   * The app still uses the STAFF_EMAILS env var for login. Migrating the app
--     to read staff_emails is a Phase 1 refactor (it touches the per-request
--     auth hot path). For now the table is the DB-side allowlist for RLS only;
--     seed it in prod with the SAME emails as STAFF_EMAILS.

-- 1. The DB-side staff allowlist. Created EMPTY — staff emails are real data
--    and are never committed (CLAUDE.md). Seed in prod by hand (see the load
--    SQL handed off with this migration). Until seeded, is_staff() returns
--    false for everyone (fail-closed) — so apply the seed BEFORE flipping in a
--    fresh environment, or staff reads break until it's seeded.
create table staff_emails (
  email      text primary key,
  created_at timestamptz not null default now()
);
-- Only service_role touches this table (the seed runs as service_role / owner).
-- authenticated has NO access — an authenticated JWT must not be able to read
-- or edit the allowlist that decides its own privilege.
alter table staff_emails enable row level security;
grant all on table staff_emails to service_role;
revoke all on table staff_emails from anon, authenticated;

-- 2. is_staff(): true iff the calling JWT's email is in the allowlist.
--    - Reads auth.jwt() ->> 'email' (present on the staff email-OTP JWTs).
--    - Fail-closed: null/absent email, or email not in the table → false. A
--      future client JWT (carrying 'phone', not a staff 'email') gets false.
--    - SECURITY DEFINER is REQUIRED: `authenticated` was revoked from
--      staff_emails above (a caller must not read the allowlist that decides its
--      own privilege). A security-invoker function would run with the caller's
--      rights and fail to read the table. As definer it reads the allowlist on
--      the caller's behalf WITHOUT granting the caller any table access.
--    - `set search_path = ''` pins schema resolution (everything is schema-
--      qualified) so the definer privilege can't be hijacked by a rogue
--      search_path. `stable`: same result within a statement.
create function is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_emails s
    -- Compare case- AND whitespace-insensitively on BOTH sides, matching
    -- lib/auth/allowlist.ts (`email.trim().toLowerCase()`). A stored email with
    -- stray case/whitespace must still match the JWT's email, or a staff member
    -- is silently denied and their pages break.
    where lower(btrim(s.email)) = lower(btrim(nullif(auth.jwt() ->> 'email', '')))
  );
$$;
-- The function is callable by the roles that hit RLS.
grant execute on function is_staff() to authenticated, anon, service_role;

-- 3. Swap every blanket policy to the staff predicate. Same policy NAME
--    (staff_full_access) so the pattern stays recognizable; only the predicate
--    changes from `true` to `is_staff()`. `for all` covers select/insert/
--    update/delete; `with check` gates writes.
--
--    Group A — client PII (staff-only now; client-owns-own is a SEPARATE
--    additive policy in Phase 1, OR-combined, no edit to these):
drop policy staff_full_access on clients;
create policy staff_full_access on clients
  for all to authenticated using (is_staff()) with check (is_staff());

drop policy staff_full_access on aliases;
create policy staff_full_access on aliases
  for all to authenticated using (is_staff()) with check (is_staff());

drop policy staff_full_access on sessions;
create policy staff_full_access on sessions
  for all to authenticated using (is_staff()) with check (is_staff());

--    Group C — internal:
drop policy staff_full_access on job_runs;
create policy staff_full_access on job_runs
  for all to authenticated using (is_staff()) with check (is_staff());

--    Group B — catalog/availability the public page will READ (staff-only for
--    now; anon SELECT + column-scoped grants come in Phase 2, additive):
drop policy staff_full_access on service_types;
create policy staff_full_access on service_types
  for all to authenticated using (is_staff()) with check (is_staff());

drop policy staff_full_access on staff;
create policy staff_full_access on staff
  for all to authenticated using (is_staff()) with check (is_staff());

drop policy staff_full_access on staff_hours;
create policy staff_full_access on staff_hours
  for all to authenticated using (is_staff()) with check (is_staff());

drop policy staff_full_access on booking_services;
create policy staff_full_access on booking_services
  for all to authenticated using (is_staff()) with check (is_staff());

drop policy staff_full_access on staff_services;
create policy staff_full_access on staff_services
  for all to authenticated using (is_staff()) with check (is_staff());

-- NOTE: bot_autoreplies is intentionally untouched — it has RLS enabled with NO
-- policy for `authenticated` (only granted to service_role), so it is already
-- closed to authenticated JWTs. Table grants to authenticated/service_role are
-- unchanged everywhere: RLS now narrows ROWS (to staff) but the table-level
-- access stays as it was.

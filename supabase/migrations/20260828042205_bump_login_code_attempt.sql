-- bump_login_code_attempt (2026-08-28): CONDITIONAL atomic attempt increment
-- for the client phone-login (Phase 1 slice 3). The verify flow burns an
-- attempt on every guess. Doing this as a plain read-then-write in the app
-- races: two concurrent guesses both read attempts=4, both proceed → the cap is
-- blown. The `where attempts < 5` guard makes BOTH the increment AND the cap
-- decision atomic under Postgres row locking: only rows still under the cap are
-- updated, and the function returns the new attempts count (or NULL if the row
-- didn't qualify — already at/over the cap, consumed-irrelevant). The flow
-- treats NULL / over-cap as a failed verify, so concurrency can't buy extra
-- guesses past the cap.
--
-- Runs as the caller (service_role, from the verify route) — SECURITY INVOKER
-- is fine; only service_role can reach login_codes anyway (RLS + grants).

create function bump_login_code_attempt(code_id uuid)
returns smallint
language sql
set search_path = ''
as $$
  update public.login_codes
     set attempts = attempts + 1
   where id = code_id
     and attempts < 5
  returning attempts;
$$;

-- Only service_role (the verify route) calls it; nobody else can touch
-- login_codes, so restrict execution to match.
revoke execute on function bump_login_code_attempt(uuid) from public, anon, authenticated;
grant execute on function bump_login_code_attempt(uuid) to service_role;

-- client_user_id_by_email: the id of the auth user with this exact email, or
-- null. Used by the verify flow to find a RETURNING client's synthetic-email
-- user without listUsers() pagination (which only scans the first page). The
-- email is unique, so this is an exact lookup.
--
-- SECURITY DEFINER because auth.users isn't reachable by service_role through
-- PostgREST; the function is owned by the migration role (which can read
-- auth.users). Locked down: schema-qualified, empty search_path, execute
-- granted ONLY to service_role (never anon/authenticated — this reads auth
-- identities). Takes an exact email, returns only the id, so it can't be used
-- to enumerate (the caller already knows the synthetic email it's looking up).
create function client_user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from auth.users where email = lower(p_email) limit 1;
$$;
revoke execute on function client_user_id_by_email(text) from public, anon, authenticated;
grant execute on function client_user_id_by_email(text) to service_role;

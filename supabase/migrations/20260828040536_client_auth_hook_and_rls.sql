-- client_auth_hook_and_rls (2026-08-28): Phase 1 slice 2 of the public-booking
-- plan. Two coupled pieces:
--   1. A custom_access_token auth hook that lifts a client's phone (stored in
--      user_metadata) into the JWT as a top-level `phone` claim.
--   2. The client-owns-own RLS policies (the seam Phase 0 reserved), keyed on
--      that phone claim — a phone-verified client reads ONLY their own clients
--      row and their own sessions, never the whole PII base.
--
-- WHY the synthetic-email design (Braulio, 2026-08-28): the stack has phone
-- login disabled (no SMS provider), so a client is a normal EMAIL user with a
-- synthetic email and the REAL E.164 phone (with '+') in user_metadata. This
-- hook is what makes that phone visible to RLS. We store E.164-with-'+', so the
-- claim matches clients.phone exactly — no format mismatch.
--
-- The hook must be ENABLED in config (CI: config.toml [auth.hook.
-- custom_access_token]; prod: the dashboard — a human task) for Supabase to
-- call it. This migration only creates the function + grants + policies.

-- 1. The hook function. Supabase calls it before issuing a token, passing an
--    `event` jsonb: { user_id, claims, authentication_method, ... }. `claims`
--    contains app_metadata. We copy app_metadata.phone (if present) to a
--    TOP-LEVEL `phone` claim, then return the modified event.
--
--    CRITICAL — app_metadata, NOT user_metadata: user_metadata is CLIENT-
--    WRITABLE (supabase.auth.updateUser({data})), so a client could set their
--    own user_metadata.phone to a VICTIM's phone and have the hook mint them a
--    victim `phone` claim → read the victim's PII. app_metadata is writable
--    ONLY by the admin API / service_role, never the client — so the phone we
--    put there at verify time cannot be forged. The verify endpoint sets it via
--    admin.updateUserById({ app_metadata: { phone } }).
--
--    - Staff JWTs (email OTP, no app_metadata.phone) are untouched → no `phone`
--      claim → is_staff() still gates them; the two roles stay cleanly split.
--    - Hardened like is_staff(): schema-qualified, empty search_path.
--    - Never errors on odd input: a null/absent phone is just a no-op, so the
--      hook can't break token issuance for any user.
create function custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  meta_phone text;
begin
  -- The client's real E.164 phone lives in app_metadata.phone (set by the admin
  -- API at verify time — NOT client-writable). Absent for staff / non-clients.
  meta_phone := event #>> '{claims,app_metadata,phone}';
  if meta_phone is not null and meta_phone <> '' then
    -- Add/overwrite a top-level `phone` claim the RLS reads.
    event := jsonb_set(event, '{claims,phone}', to_jsonb(meta_phone), true);
  end if;
  return event;
end;
$$;

-- Supabase's auth server (role supabase_auth_admin) must be able to run the
-- hook; nobody else needs it. Revoke from the general roles defensively.
grant execute on function custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function custom_access_token_hook(jsonb) from authenticated, anon, public;

-- 2. A helper mirroring is_staff(): the calling client's phone claim, or null.
--    Centralizes the null/empty guard so the policies read cleanly.
create function client_phone()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'phone', '');
$$;
grant execute on function client_phone() to authenticated, anon, service_role;

-- 3. Client-owns-own policies — ADDITIVE, alongside the existing
--    staff_full_access (Postgres OR-combines permissive policies). SELECT only:
--    a client reads their own data; they never UPDATE/DELETE directly (edits go
--    through scoped endpoints). Staff JWTs carry no `phone` claim, so
--    client_phone() is null for them and these policies grant them nothing
--    extra — the roles stay separate (the same fail-closed discipline as
--    is_staff()).
--
--    A client sees only the clients row whose phone equals their claim. A brand-
--    new client (no row yet) simply matches nothing — correct.
create policy client_owns_own on clients
  for select to authenticated
  using (client_phone() is not null and phone = client_phone());

--    ...and only their own sessions.
create policy client_owns_own on sessions
  for select to authenticated
  using (
    client_phone() is not null
    and client_id in (
      select c.id from public.clients c where c.phone = client_phone()
    )
  );

-- Note: aliases are staff-only (a client has no need to read alias rows); no
-- client policy is added there. booking catalog tables (service_types, staff,
-- staff_hours, booking_services, staff_services) get their ANON read policy in
-- Phase 2 (the public page), separate from this client-identity work.

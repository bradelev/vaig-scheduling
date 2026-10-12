-- login_codes (2026-08-28): the client phone-login OTP store (Phase 1 of the
-- public-booking plan, the internal booking plan). We generate the 6-digit
-- code, hash it (phone + pepper bound, see lib/client-auth/otp.ts), store it
-- here, and send it by WhatsApp. The verify route reads the active row, does a
-- constant-time hash compare, and on success mints a Supabase session.
--
-- SECURITY POSTURE: clients NEVER touch this table. Only the service_role
-- endpoints (request-code / verify-code) read and write it — same lockdown as
-- staff_emails (migration 20260827204501): RLS on, granted to service_role
-- only, revoked from anon + authenticated. A leaked code_hash reveals nothing
-- without the phone AND the server pepper.

create table login_codes (
  id          uuid primary key default gen_random_uuid(),
  -- E.164, normalized by normalizePhoneIntl BEFORE insert. Deliberately NOT a
  -- FK to clients: a brand-new client has no clients row yet, and we must not
  -- reveal client existence at issue time (anti-enumeration).
  phone       text not null,
  -- SHA-256(phone : code : server-pepper), lowercase hex. Never the plaintext.
  code_hash   text not null,
  expires_at  timestamptz not null,
  -- Verify attempts consumed against THIS code (capped at MAX_ATTEMPTS in code).
  attempts    smallint not null default 0 check (attempts >= 0),
  -- Single-use: set on the successful verify; a consumed code can't be reused.
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

-- Rate-limit / active-code lookups are per-phone, newest first.
create index login_codes_phone_created_idx on login_codes (phone, created_at desc);
-- The verify path looks up the active (unconsumed) code for a phone.
create index login_codes_active_idx on login_codes (phone) where consumed_at is null;

-- RLS: service_role only. authenticated and anon get NOTHING — the OTP store is
-- never client-reachable; the endpoints run as service_role.
alter table login_codes enable row level security;
grant all on table login_codes to service_role;
revoke all on table login_codes from anon, authenticated;

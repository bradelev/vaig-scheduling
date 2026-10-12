-- v3 (PRD Part II §II.2/§II.4/§II.6/§II.7): schema foundation for
-- app-created sessions (structured CRUD) living alongside the v2 calendar
-- cascade. This migration is ADDITIVE and safe on the live prod table:
-- it adds columns/constraints and a service-type catalog, and never drops
-- or rewrites existing data. External/manual rows keep working unchanged.
--
-- What changes and why:
--   1. source gains 'app'        -> distinguishes CRUD-created sessions.
--   2. gcal_event_id nullable    -> an app session is born BEFORE its mirror
--      + PLAIN unique index         event exists (the event is written in
--                                    T3.1). NULLs are DISTINCT so many app
--                                    rows coexist; a plain (not partial) index
--                                    is required so the sync's onConflict:
--                                    "gcal_event_id" upsert still infers.
--   3. client_id required IFF     -> app sessions always have an identity;
--      source='app' (CHECK)          external/manual stay nullable (cascade).
--   4. divergence columns        -> a moved mirror event (§II.6) is flagged
--      (orthogonal to status)        without disturbing status; a confirmed
--                                    session can also diverge.
--   5. per-session note          -> free-text note for THIS appointment,
--                                    distinct from clients.notes.
--   6. service_types catalog     -> revives the never-populated `service` as
--      + app-only trigger            BROAD categories, GROWABLE via INSERT.
--                                    Enforced ONLY for source='app' (the CRUD
--                                    picker) via a trigger; external/manual keep
--                                    free-text service (a plain FK would reject
--                                    theirs, e.g. fixtures' "maderoterapia").
--   7. clients.is_first_visit    -> "first time at VAIG" flag for follow-up;
--                                    NOT derived from "exists in DB" (a client
--                                    can be added late yet be a first visit).
--   8. set_updated_at() trigger  -> folds TECH_DEBT 2026-07-17: updated_at
--                                    was never bumped on UPDATE. v3's CRUD
--                                    does constant updates, so this is now a
--                                    real need, not latent.
-- Timezone for all date logic: America/Montevideo (no DST). No time math here.

begin;

-- 1. + 3. source 'app' and app-origin identity requirement.
-- The existing CHECK on `source` is dropped and re-created with 'app' added;
-- the check name is Postgres's default (sessions_source_check). We also add
-- a conditional identity constraint: app sessions must have a client.
alter table sessions drop constraint if exists sessions_source_check;
alter table sessions
  add constraint sessions_source_check
  check (source in ('external', 'manual', 'unknown', 'app'));

-- NOT VALID: only NEW writes are checked, so applying this never scans or
-- rejects existing prod rows (all currently external/manual/unknown, so none
-- are 'app' — but NOT VALID keeps the migration safe regardless of any legacy
-- state). App-origin sessions are only ever created by the CRUD, which always
-- supplies a client_id, so new writes satisfy it.
alter table sessions
  add constraint sessions_app_needs_client
  check (source <> 'app' or client_id is not null)
  not valid;

-- 2. gcal_event_id: nullable, kept UNIQUE via a plain (non-partial) unique
-- index. An app session has no calendar event until T3.1 writes its mirror, so
-- the column must allow NULL — which the old `unique not null` forbade.
--
-- A PLAIN unique index (not a partial one) is deliberate and load-bearing:
--   - Postgres treats NULLs as DISTINCT by default (NULLS DISTINCT; the
--     NULLS NOT DISTINCT opt-in is never used here, PG17), so MANY app rows
--     with a NULL gcal_event_id coexist — exactly what we need.
--   - Only a plain unique index can back the sync's ON CONFLICT inference:
--     `sync-calendar` upserts with `onConflict: "gcal_event_id"` (PostgREST
--     emits a bare `ON CONFLICT (gcal_event_id)`), and Postgres CANNOT infer
--     a conflict target from a PARTIAL unique index. A partial index here
--     would silently break every hourly sync in prod. (Caught in review.)
alter table sessions alter column gcal_event_id drop not null;
-- Reuse the same constraint NAME the init migration's column-level UNIQUE had,
-- so nothing that references it by name drifts. Drop the implicit constraint
-- (frees its backing index) and recreate an equivalent unique index.
alter table sessions drop constraint if exists sessions_gcal_event_id_key;
create unique index if not exists sessions_gcal_event_id_key
  on sessions (gcal_event_id);

-- 4. Divergence (§II.6), orthogonal to status. When the sync detects that an
-- app-managed mirror event was moved/edited in the calendar, it records WHEN
-- it noticed and the calendar's PROPOSED time, so the "Hoy" screen can offer
-- "apply the change vs restore the app's time". Null = no divergence pending.
alter table sessions
  add column if not exists divergence_detected_at timestamptz,
  add column if not exists proposed_starts_at timestamptz;

-- 5. Per-session free-text note (distinct from clients.notes, which is about
-- the client in general). Kept deliberately as a single free-text field for
-- THIS appointment — not a notes system (session notes / historia clínica are
-- out of scope, PRD Part II §II.3).
alter table sessions
  add column if not exists note text;

-- 6. Service-CATEGORY catalog. A small set of BROAD categories (depilación,
-- hifu, …) — NOT the long External service list with all its variants (axila,
-- bozo, …). The CRUD shows this short list as a picker; the fine detail
-- (body area, power, etc.) goes in the free-text `note`. The reminder says
-- "tu sesión de depilación" — the category is enough. A lookup table (not a
-- CHECK) so categories grow via INSERT, not a migration, and can later back a
-- settings picker.
create table if not exists service_types (
  slug       text primary key,          -- stable id used in sessions.service
  label      text not null,             -- customer-facing label (Spanish)
  active     boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- Seed CATEGORIES (Braulio, 2026-08-07). More added later via INSERT.
-- Idempotent on re-run.
insert into service_types (slug, label, sort_order) values
  ('depilacion',      'Depilación',      10),
  ('hifu',            'HIFU',            20),
  ('botox',           'Botox',           30),
  ('masaje',          'Masaje',          40),
  ('radiofrecuencia', 'Radiofrecuencia', 50),
  ('limpieza_facial', 'Limpieza facial', 60),
  ('unas',            'Uñas',            70)
on conflict (slug) do nothing;

-- Catalog is enforced ONLY for app-origin sessions (source='app', created by
-- the CRUD picker). External/manual sessions keep whatever `service` the
-- calendar/legacy carried (or NULL) — they never go through the picker, and a
-- plain FK would wrongly reject their free-text service values (e.g. the
-- integration fixtures' "maderoterapia"). Postgres has no conditional FK, so
-- a lightweight BEFORE trigger validates the category only when it applies.
create or replace function validate_app_service()
returns trigger
language plpgsql
as $$
begin
  if new.source = 'app'
     and new.service is not null
     and not exists (select 1 from service_types where slug = new.service) then
    raise exception
      'service "%" is not a known service_types category (app-origin session)',
      new.service
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists validate_app_service on sessions;
create trigger validate_app_service
  before insert or update on sessions
  for each row execute function validate_app_service();

-- 7. First-visit flag on clients (once per client). Explicitly a stored flag,
-- NOT "row didn't exist before": a client may be entered late yet still be a
-- first visit, and adding a client to the DB does not mean they are new.
-- Defaults false; the CRUD sets it true when the operator checks the box.
alter table clients
  add column if not exists is_first_visit boolean not null default false;

-- 8. set_updated_at() trigger (folds TECH_DEBT 2026-07-17). Bumps updated_at
-- on every UPDATE for clients and sessions, so the column stops lying. v3's
-- CRUD updates rows constantly (edit/move/cancel), making this necessary now.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on clients;
create trigger set_updated_at
  before update on clients
  for each row execute function set_updated_at();

drop trigger if exists set_updated_at on sessions;
create trigger set_updated_at
  before update on sessions
  for each row execute function set_updated_at();

-- RLS for the new table: same single-level staff policy as the rest (PRD §6).
-- (The blanket using(true) is tracked HIGH debt, out of scope here — this new
-- table simply matches the existing posture rather than diverging from it.)
alter table service_types enable row level security;
create policy staff_full_access on service_types
  for all to authenticated using (true) with check (true);
grant all on table service_types to authenticated, service_role;
revoke all on table service_types from anon;

commit;

-- availability_engine (2026-08-26): the data model for VAIG's own online
-- booking — Phase 1 of the online booking plan
-- (the internal booking plan). This migration is DATA ONLY (no
-- public surface yet): per-service duration + per-staff working-hour rules.
-- The slot-computation logic (Phase 1B) and the UI (Phase 1C) come next.
--
-- Timezone note: all time-of-day here is LOCAL Montevideo wall-clock (no DST
-- since 2015, fixed -03:00). The slot engine converts to instants when it
-- intersects with sessions.

-- 1. Per-service duration. Today duration is a flat 60-min default in code
--    (DEFAULT_DURATION_MINUTES). A real booking needs it per service so the
--    engine knows how long a slot must be.
alter table service_types
  add column duration_min integer not null default 60;

-- 2. Working-hour RULES per staff member. A rule engine (Google-Calendar
--    style), not a flat schedule — staff hours are irregular. Three rule kinds:
--    - 'weekly'  : recurring by weekday      (weekday set, date null)
--    - 'open'    : one-off extra availability (date set, weekday null)
--    - 'block'   : one-off closure/day-off    (date set; a full-day block may
--                  omit the time range → closed all day)
--    NOTE (for the 1C admin UI): a 'block' is a SINGLE date. A multi-day
--    closure (e.g. a vacation) is N rows, one per day. Accepted for now; if the
--    UI needs multi-day absences, add a range-to-rows helper there — not a
--    schema change.
--    Availability of a given day = (weekly rules for that weekday ∪ 'open'
--    rules for that date) − 'block' rules for that date − already-booked
--    sessions. (Buffer between sessions: none for now — sessions can be
--    back-to-back; add later if needed.)
create table staff_hours (
  id          uuid primary key default gen_random_uuid(),
  staff_id    text not null references staff(id) on delete cascade,
  kind        text not null check (kind in ('weekly', 'open', 'block')),
  -- For 'weekly': 0=Sunday … 6=Saturday (Montevideo). Null for 'open'/'block'.
  weekday     smallint check (weekday between 0 and 6),
  -- For 'open'/'block': the specific local date. Null for 'weekly'.
  on_date     date,
  -- Local wall-clock range "HH:MM". Both null on a full-day 'block' (closed all
  -- day). For 'weekly'/'open' both are required (enforced below).
  start_min   smallint check (start_min between 0 and 1440),
  end_min     smallint check (end_min between 0 and 1440),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Shape rules per kind:
  constraint staff_hours_weekly_shape check (
    kind <> 'weekly' or (weekday is not null and on_date is null
      and start_min is not null and end_min is not null and start_min < end_min)
  ),
  constraint staff_hours_open_shape check (
    kind <> 'open' or (on_date is not null and weekday is null
      and start_min is not null and end_min is not null and start_min < end_min)
  ),
  -- 'block' with a range = partial closure; 'block' with null range = all-day.
  constraint staff_hours_block_shape check (
    kind <> 'block' or (on_date is not null and weekday is null
      and ((start_min is null and end_min is null)
           or (start_min is not null and end_min is not null and start_min < end_min)))
  )
);

create index staff_hours_staff_idx on staff_hours (staff_id);
create index staff_hours_date_idx on staff_hours (on_date) where on_date is not null;

-- Keep updated_at fresh (reuses the existing set_updated_at() function from
-- migration 20260807233345 — folds TECH_DEBT 2026-07-17; without this the
-- column would silently equal created_at forever, the exact bug that trigger
-- was created to fix).
drop trigger if exists set_updated_at on staff_hours;
create trigger set_updated_at
  before update on staff_hours
  for each row execute function set_updated_at();

-- RLS: same single-level policy as clients/sessions/staff — authenticated staff
-- full access, anon nothing; service_role bypasses RLS but needs the grant.
alter table staff_hours enable row level security;
create policy staff_full_access on staff_hours
  for all to authenticated using (true) with check (true);
grant all on table staff_hours to authenticated, service_role;
revoke all on table staff_hours from anon;

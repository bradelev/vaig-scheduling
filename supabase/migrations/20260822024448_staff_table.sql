-- staff_table (2026-08-22): the attending-staff catalog moves from a hardcoded
-- list (lib/sessions/staff.ts) to a DB table, so staff — and their PHONE — can
-- be managed as data. Two things need this: the "Quién atiende" column becomes
-- editable, and creating a session can WhatsApp the assigned employee (needs
-- her phone). Direction (Braulio 2026-08-21): employees are VAIG's own data,
-- not read from any external booking app.
--
-- SENSITIVE DATA: real phone numbers are NEVER committed (project rule). The
-- seed carries the 7 existing names + their calendar colors only; phone stays
-- NULL and is loaded in prod by hand (or later via a management screen).
--
-- id is the stable text key already stored in sessions.attended_by ("lu",
-- "stephany", …), so existing sessions keep resolving without a backfill.

create table staff (
  id         text primary key,          -- stable key, = sessions.attended_by
  name       text not null,             -- display name (staff UI, Spanish)
  phone      text,                      -- E.164 (+598…); NULL until loaded in prod
  color_id   integer,                   -- Google Calendar event colorId (1–11)
  active      boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS (same single-level policy as clients/sessions): authenticated staff full
-- access, anon nothing; service_role bypasses RLS but still needs grants.
alter table staff enable row level security;
create policy staff_full_access on staff
  for all to authenticated using (true) with check (true);
grant all on table staff to authenticated, service_role;
revoke all on table staff from anon;

-- Seed: the 7 employees from lib/sessions/staff.ts with their colorId legend.
-- Colors: 1 Lavender · 2 Sage · 3 Grape · 6 Tangerine · 8 Graphite · 9
-- Blueberry · 10 Basil. Phone intentionally NULL — real numbers loaded in prod.
insert into staff (id, name, color_id) values
  ('stephany', 'Stephany', 3),
  ('lu',       'Lu',       1),
  ('iara',     'Iara',     9),
  ('cyn',      'Cyn',      6),
  ('joana',    'Joana',    2),
  ('angel',    'Angel',    8),
  ('leticia',  'Leticia',  10)
on conflict (id) do nothing;

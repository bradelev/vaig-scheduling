-- 0001_init (PRD §6): core tables, indexes and RLS.
-- Calendar is the source of truth for sessions; `clients` is the source of
-- truth for identity. Last/next session are never stored — they arrive as
-- SQL views in the next migration (E1-T2).

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

-- RLS (PRD §6): single policy level — `authenticated` (staff) full access,
-- `anon` nothing. Edge functions and scripts use service_role, which
-- bypasses RLS but still needs table grants.

alter table clients enable row level security;
alter table aliases enable row level security;
alter table sessions enable row level security;
alter table job_runs enable row level security;

create policy staff_full_access on clients
  for all to authenticated using (true) with check (true);
create policy staff_full_access on aliases
  for all to authenticated using (true) with check (true);
create policy staff_full_access on sessions
  for all to authenticated using (true) with check (true);
create policy staff_full_access on job_runs
  for all to authenticated using (true) with check (true);

-- Explicit grants: newer Supabase projects no longer auto-expose new
-- tables to the Data API roles; the linked v1-era project may still
-- auto-grant, so anon is revoked defensively either way.
grant all on table clients, aliases, sessions, job_runs to authenticated, service_role;
revoke all on table clients, aliases, sessions, job_runs from anon;

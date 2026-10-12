-- Booking analytics + recovery queue + panel usage (scope expansion approved
-- by Braulio, 2026-09-02 — see docs/booking-analytics.md; the original §3
-- "analytics" prohibition is consciously lifted for THIS in-house, anonymous
-- instrumentation only, never a third-party tracker).
--
-- Three tables + one aggregate RPC:
--  1. booking_events   — ANONYMOUS public-funnel events (never phone/name;
--                        session_key is a random browser UUID).
--  2. booking_recovery — the "reservas a medio camino" queue: VERIFIED phones
--                        that chose a service/slot but never completed. Short
--                        retention (14 days, swept app-side), staff work it by
--                        hand (wa.me), one row per phone.
--  3. panel_events     — which panel screens the team actually opens (route
--                        only — shared logins make person-level moot).
-- Retention is swept opportunistically from the app endpoints (the
-- rate_limit_hit pattern): booking_events 180d, panel_events 180d,
-- booking_recovery 14d. No cron needed.

create table booking_events (
  id                 uuid primary key default gen_random_uuid(),
  session_key        uuid not null,
  event              text not null check (event in (
    'page_view', 'service_selected', 'staff_selected', 'no_slots_seen',
    'slot_selected', 'code_requested', 'code_verified',
    'reserve_ok', 'reserve_conflict', 'reserve_error'
  )),
  booking_service_id uuid references booking_services (id) on delete set null,
  staff_id           text,
  -- The Monday of the week the client was looking at (no_slots_seen).
  week_key           date,
  -- The chosen slot instant (slot_selected / reserve_*).
  slot_at            timestamptz,
  created_at         timestamptz not null default now()
);
create index booking_events_created_idx on booking_events (created_at);
create index booking_events_event_idx on booking_events (event, created_at);

alter table booking_events enable row level security;
create policy staff_read_events on booking_events
  for select to authenticated using (is_staff());
grant select on table booking_events to authenticated;
grant all on table booking_events to service_role;
revoke all on table booking_events from anon;

create table booking_recovery (
  -- One row per verified phone: the LATEST intent wins (upsert).
  phone              text primary key,
  client_id          uuid references clients (id) on delete cascade,
  booking_service_id uuid references booking_services (id) on delete set null,
  slot_at            timestamptz,
  updated_at         timestamptz not null default now(),
  contacted_at       timestamptz
);

alter table booking_recovery enable row level security;
create policy staff_work_recovery on booking_recovery
  for select to authenticated using (is_staff());
create policy staff_update_recovery on booking_recovery
  for update to authenticated using (is_staff()) with check (is_staff());
grant select, update on table booking_recovery to authenticated;
grant all on table booking_recovery to service_role;
revoke all on table booking_recovery from anon;

create table panel_events (
  id         uuid primary key default gen_random_uuid(),
  route      text not null,
  created_at timestamptz not null default now()
);
create index panel_events_created_idx on panel_events (created_at);

alter table panel_events enable row level security;
create policy staff_read_panel_events on panel_events
  for select to authenticated using (is_staff());
grant select on table panel_events to authenticated;
grant all on table panel_events to service_role;
revoke all on table panel_events from anon;

-- One round trip for the Métricas screen: every aggregate as jsonb. SECURITY
-- INVOKER (the default) on purpose — the caller is the staff cookie session
-- and the RLS select policies above are what gate the rows; anon cannot even
-- execute it.
create function booking_metrics(p_days integer)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with ev as (
    select * from public.booking_events
    where created_at > now() - make_interval(days => greatest(1, least(365, p_days)))
  )
  select jsonb_build_object(
    'funnel', coalesce((
      select jsonb_object_agg(f.event, f.n)
      from (select e.event, count(distinct e.session_key) as n from ev e group by e.event) f
    ), '{}'::jsonb),
    'no_slots', coalesce((
      select jsonb_agg(t) from (
        select bs.name, e.week_key, count(*) as times
        from ev e join public.booking_services bs on bs.id = e.booking_service_id
        where e.event = 'no_slots_seen'
        group by bs.name, e.week_key
        order by count(*) desc
        limit 12
      ) t
    ), '[]'::jsonb),
    'per_service', coalesce((
      select jsonb_agg(t) from (
        select bs.name,
               count(distinct e.session_key) filter (where e.event = 'service_selected') as viewed,
               count(distinct e.session_key) filter (where e.event = 'reserve_ok') as booked
        from ev e join public.booking_services bs on bs.id = e.booking_service_id
        where e.event in ('service_selected', 'reserve_ok')
        group by bs.name
        order by 2 desc
        limit 12
      ) t
    ), '[]'::jsonb),
    'hours', coalesce((
      select jsonb_object_agg(t.h, t.n) from (
        select extract(hour from e.created_at at time zone 'America/Montevideo')::int as h,
               count(*) as n
        from ev e
        where e.event = 'page_view'
        group by 1
      ) t
    ), '{}'::jsonb),
    'panel_usage', coalesce((
      select jsonb_object_agg(t.route, t.n) from (
        select p.route, count(*) as n
        from public.panel_events p
        where p.created_at > now() - make_interval(days => greatest(1, least(365, p_days)))
        group by p.route
      ) t
    ), '{}'::jsonb)
  )
$$;

revoke execute on function booking_metrics(integer) from public, anon;
grant execute on function booking_metrics(integer) to authenticated, service_role;

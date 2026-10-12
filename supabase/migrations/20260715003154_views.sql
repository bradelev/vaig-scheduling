-- 0002_views (PRD §6): read views over clients/sessions.
-- Last/next session are computed here, never stored (calendar is the
-- source of truth). Cancelled sessions are excluded everywhere.
--
-- security_invoker: without it a view runs with its owner's privileges
-- (postgres) and would bypass the tables' RLS. Staff policy is
-- `using (true)`, so results are identical — this is defense in depth
-- and keeps the Supabase security linter green.

create view v_client_status
  with (security_invoker = on) as
select
  c.id, c.full_name, c.phone, c.opted_out, c.last_reactivation_at,
  ls.last_session_at, ls.last_service,
  ns.next_session_at, ns.next_session_id, ns.next_status, ns.next_confirmed_at,
  case when ls.last_session_at is not null
       then extract(day from now() - ls.last_session_at)::int end as days_since_last
from clients c
left join lateral (
  select starts_at as last_session_at, service as last_service
  from sessions s
  where s.client_id = c.id and s.starts_at < now() and s.status <> 'cancelled'
  order by starts_at desc limit 1
) ls on true
left join lateral (
  select id as next_session_id, starts_at as next_session_at,
         status as next_status, confirmed_at as next_confirmed_at
  from sessions s
  where s.client_id = c.id and s.starts_at >= now() and s.status <> 'cancelled'
  order by starts_at asc limit 1
) ns on true;

create view v_unmatched
  with (security_invoker = on) as
select id, gcal_event_id, starts_at, service, raw_title, raw_description, source
from sessions
where client_id is null and status <> 'cancelled'
order by starts_at desc;

create view v_reactivation
  with (security_invoker = on) as
select * from v_client_status
where next_session_at is null
  and last_session_at is not null
  and days_since_last > 21          -- REACTIVATION_DAYS
  and opted_out = false
order by days_since_last asc;        -- most recent first: most recoverable

-- Same grant pattern as 0001_init: staff and service_role read, anon nothing.
grant select on v_client_status, v_unmatched, v_reactivation
  to authenticated, service_role;
revoke all on v_client_status, v_unmatched, v_reactivation from anon;

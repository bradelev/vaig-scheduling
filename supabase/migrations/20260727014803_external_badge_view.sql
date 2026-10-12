-- 0009_external_badge_view (issue #89): the Clientas badge must distinguish
-- "VAIG will remind / is waiting" from "External owns this one". A session
-- External manages can never confirm through VAIG (confirm buttons only ride
-- VAIG reminders, and FR-2 excludes External bookings), so showing it as
-- "pendiente" promises an action that will never come.
--
-- create or replace may only APPEND columns: same list as 0006, plus
-- next_source and next_external_covered at the end.
--
-- next_external_covered mirrors FR-2's external_covers_same_day rule: a
-- SCHEDULED external-source session of the same client on the same
-- America/Montevideo calendar day (covers both the external booking itself
-- and its manual twin). A cancelled external session covers nothing.

create or replace view v_client_status
  with (security_invoker = on) as
select
  c.id, c.full_name, c.phone, c.opted_out, c.last_reactivation_at,
  ls.last_session_at, ls.last_service,
  ns.next_session_at, ns.next_session_id, ns.next_status, ns.next_confirmed_at,
  case when ls.last_session_at is not null
       then extract(day from now() - ls.last_session_at)::int end as days_since_last,
  c.reactivation_outcome,
  ns.next_source,
  ns.next_external_covered
from clients c
left join lateral (
  select starts_at as last_session_at, service as last_service
  from sessions s
  where s.client_id = c.id and s.starts_at < now() and s.status <> 'cancelled'
  order by starts_at desc limit 1
) ls on true
left join lateral (
  select id as next_session_id, starts_at as next_session_at,
         status as next_status, confirmed_at as next_confirmed_at,
         s.source as next_source,
         exists (
           select 1 from sessions k
           where k.client_id = c.id
             and k.source = 'external'
             and k.status = 'scheduled'
             and (k.starts_at at time zone 'America/Montevideo')::date
               = (s.starts_at at time zone 'America/Montevideo')::date
         ) as next_external_covered
  from sessions s
  where s.client_id = c.id and s.starts_at >= now() and s.status <> 'cancelled'
  order by starts_at asc limit 1
) ns on true;

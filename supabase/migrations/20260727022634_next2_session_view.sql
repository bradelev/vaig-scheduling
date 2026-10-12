-- 0010_next2_session_view (issue #92): the desk's rebooking signal. Under
-- "Próxima" the UI shows a discreet "luego: …" line when the client already
-- has a booking on a LATER Montevideo day; its absence means "offer a date
-- before she leaves".
--
-- "Later" is by local calendar DAY, not instant: a same-day second service
-- or a external/manual twin at the same time is not a next visit. When there
-- is no next session at all, the comparison is against NULL and next2 stays
-- NULL.
--
-- Stacked on 0009: same column list, plus next2_session_at appended.

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
  ns.next_external_covered,
  ns2.next2_session_at
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
) ns on true
left join lateral (
  select s2.starts_at as next2_session_at
  from sessions s2
  where s2.client_id = c.id and s2.status <> 'cancelled'
    and (s2.starts_at at time zone 'America/Montevideo')::date
      > (ns.next_session_at at time zone 'America/Montevideo')::date
  order by s2.starts_at asc limit 1
) ns2 on true;

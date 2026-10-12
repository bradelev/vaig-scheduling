-- Let staff remove a MATCHED session that came from the calendar (2026-08-13).
-- Bug: a session ingested from the calendar (source manual/external) whose event
-- was later deleted from Google Calendar stays orphaned in the app forever —
-- cancelSession is gated to source='app', and dismissSession is gated to
-- unmatched rows (client_id null). So an identified, non-app session had no way
-- out (a reported support case).
--
-- Fix, two parts:
--   1. (this migration) v_client_status must HIDE dismissed sessions. It filters
--      status<>'cancelled' but never dismissed_at, so stamping dismissed_at on a
--      matched row wouldn't remove it from the agenda. Add `dismissed_at is null`
--      to all three lateral joins (last / next / next2). The sync never CLEARS
--      dismissed_at (issue #84), so the dismissal survives every future sync —
--      and since the event is already gone from the calendar, the sync won't
--      re-create the row anyway.
--   2. a new server action `dismissMatchedSession` stamps dismissed_at on a
--      matched, non-app session (dismissSession itself is unchanged).
--
-- Pure additive redefinition: same column list/order as 20260810120000, only
-- the WHERE clauses of the lateral joins change. security_invoker stays on.

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
  ns2.next2_session_at,
  c.is_first_visit,
  c.review_requested_at,
  c.reviewed_at
from clients c
left join lateral (
  select starts_at as last_session_at, service as last_service
  from sessions s
  where s.client_id = c.id and s.starts_at < now() and s.status <> 'cancelled'
    and s.dismissed_at is null
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
             and k.dismissed_at is null
             and (k.starts_at at time zone 'America/Montevideo')::date
               = (s.starts_at at time zone 'America/Montevideo')::date
         ) as next_external_covered
  from sessions s
  where s.client_id = c.id and s.starts_at >= now() and s.status <> 'cancelled'
    and s.dismissed_at is null
  order by starts_at asc limit 1
) ns on true
left join lateral (
  select s2.starts_at as next2_session_at
  from sessions s2
  where s2.client_id = c.id and s2.status <> 'cancelled'
    and s2.dismissed_at is null
    and (s2.starts_at at time zone 'America/Montevideo')::date
      > (ns.next_session_at at time zone 'America/Montevideo')::date
  order by s2.starts_at asc limit 1
) ns2 on true;

-- 0006_reactivation_outcome (issue #53, product audit investment #3):
-- close the reactivation loop. "Contacted" alone was a dead end — no
-- outcome, and v_reactivation kept re-showing a declined client every
-- ~22 days. The outcome lives on clients; the view hides recently
-- contacted clients (14 days grace, 60 for 'declined' — defaults to be
-- validated with the team in E3-T5/#20).

alter table clients add column reactivation_outcome text
  check (reactivation_outcome in ('rebooked', 'declined', 'no_reply'));

-- create or replace view may only APPEND columns: same list as 0002,
-- plus reactivation_outcome at the end.
create or replace view v_client_status
  with (security_invoker = on) as
select
  c.id, c.full_name, c.phone, c.opted_out, c.last_reactivation_at,
  ls.last_session_at, ls.last_service,
  ns.next_session_at, ns.next_session_id, ns.next_status, ns.next_confirmed_at,
  case when ls.last_session_at is not null
       then extract(day from now() - ls.last_session_at)::int end as days_since_last,
  c.reactivation_outcome
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

-- v_reactivation: same base filters as 0002 plus the loop-closing rule:
-- hide anyone contacted in the last 14 days (whatever the outcome), and
-- keep a declined client hidden for 60 days after the contact.
create or replace view v_reactivation
  with (security_invoker = on) as
select * from v_client_status
where next_session_at is null
  and last_session_at is not null
  and days_since_last > 21          -- REACTIVATION_DAYS
  and opted_out = false
  and (
    last_reactivation_at is null
    or (
      last_reactivation_at < now() - interval '14 days'
      and (
        reactivation_outcome is distinct from 'declined'
        or last_reactivation_at < now() - interval '60 days'
      )
    )
  )
order by days_since_last asc;        -- most recent first: most recoverable

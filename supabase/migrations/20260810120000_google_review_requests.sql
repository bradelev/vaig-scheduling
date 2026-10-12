-- Google review requests (feature 2026-08-10): grow VAIG's Google reviews for
-- local SEO by asking loyal clients — those with 3+ completed sessions — to
-- leave one. Loyalty (not a pre-survey) is the eligibility signal: filtering by
-- sentiment before showing the review link is "review gating" and violates
-- Google/FTC policy, whereas asking recurring clients is legitimate and skews
-- positive on its own. We never know from Google's API who actually reviewed,
-- so `reviewed_at` is set MANUALLY by staff; `review_requested_at` records the
-- ask so we don't re-ask (grace window, same shape as reactivation).

alter table clients add column review_requested_at timestamptz; -- last ask
alter table clients add column reviewed_at          timestamptz; -- manual "ya reseñó"

-- Append the two new columns to v_client_status. CREATE OR REPLACE VIEW may
-- only APPEND (inserting mid-list is read as a rename → SQLSTATE 42P16), so
-- both go LAST, after is_first_visit, every prior column unchanged.
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

-- v_review_candidates: loyal clients eligible for a Google review ask.
-- A "completed session" is one that is in the past and not cancelled (the app
-- has no explicit completed state; a scheduled past session means she came).
-- Eligibility:
--   - 3+ completed sessions (loyalty threshold, REVIEW_MIN_SESSIONS)
--   - never marked as reviewed (reviewed_at is null)
--   - not opted out of messaging (reuse the existing flag)
--   - not asked in the last 90 days (grace window, REVIEW_GRACE_DAYS) — a single
--     ask per season is plenty; re-asking a non-responder is noise.
-- Most-recently-active first: her last visit is freshest, best moment to ask.
create or replace view v_review_candidates
  with (security_invoker = on) as
select
  c.id, c.full_name, c.phone,
  cs.completed_count,
  cs.last_completed_at,
  cs.last_completed_service,
  c.review_requested_at
from clients c
join lateral (
  select
    count(*)::int as completed_count,
    max(s.starts_at) as last_completed_at,
    (array_agg(s.service order by s.starts_at desc)
       filter (where s.service is not null))[1] as last_completed_service
  from sessions s
  where s.client_id = c.id
    and s.starts_at < now()
    and s.status <> 'cancelled'
    and s.dismissed_at is null
) cs on true
where cs.completed_count >= 3          -- REVIEW_MIN_SESSIONS
  and c.reviewed_at is null
  and c.opted_out = false
  and (
    c.review_requested_at is null
    or c.review_requested_at < now() - interval '90 days'  -- REVIEW_GRACE_DAYS
  )
order by cs.last_completed_at desc;

grant select on v_review_candidates to authenticated, service_role;
revoke all on v_review_candidates from anon;

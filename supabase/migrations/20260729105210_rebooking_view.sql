-- 0011_rebooking_view (issue #107): the retention pulse. Rebooking rate =
-- of the sessions a client actually attended, how many were followed by
-- ANOTHER session (any channel — a rebooking is a rebooking). The heavy
-- "did a later session exist?" check lives in SQL; the page just counts.
--
-- v_rebooking_past: one row per matched, non-cancelled PAST session in a
-- rolling 60-day window, with has_later = does that client have any later
-- non-cancelled session. The page applies the 3-day grace and the ratio
-- (rebookingRate in lib/clients/status.ts) so the boundary is unit-tested.

create view v_rebooking_past
  with (security_invoker = on) as
select
  s.client_id,
  s.starts_at,
  exists (
    -- A rebooking is a next VISIT, so compare by Montevideo calendar DAY
    -- (same rule as v_client_status.next2_session_at, #92): a second
    -- service the SAME day is not a re-booking, it's the same visit.
    select 1 from sessions s2
    where s2.client_id = s.client_id
      and s2.status <> 'cancelled'
      and (s2.starts_at at time zone 'America/Montevideo')::date
        > (s.starts_at at time zone 'America/Montevideo')::date
  ) as has_later
from sessions s
where s.client_id is not null
  and s.status <> 'cancelled'
  and s.starts_at < now()
  and s.starts_at >= now() - interval '60 days';

grant select on v_rebooking_past to authenticated, service_role;
revoke all on v_rebooking_past from anon;

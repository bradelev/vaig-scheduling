-- 0005_dismissed_sessions (issue #48): operator-dismissable non-sessions.
-- Events the §7.0 patterns don't catch (bills, notes) land in the unmatched
-- queue; the operator marks them "not a session". The flag lives in its own
-- column because the hourly sync upserts status on every event it still
-- sees — a status-based dismiss would be resurrected within the hour. The
-- sync never writes dismissed_at, so the dismissal survives.

alter table sessions add column dismissed_at timestamptz;

-- Same column list as 0002 (create or replace requires it); adds the
-- dismissed filter. Grants and security_invoker carry over / re-stated.
create or replace view v_unmatched
  with (security_invoker = on) as
select id, gcal_event_id, starts_at, service, raw_title, raw_description, source
from sessions
where client_id is null
  and status <> 'cancelled'
  and dismissed_at is null
order by starts_at desc;

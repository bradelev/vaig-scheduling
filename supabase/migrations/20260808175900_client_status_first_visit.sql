-- Expose clients.is_first_visit on v_client_status (issue #128): the Clientes
-- grid needs the first-visit flag as an editable column, and the view is the
-- single read surface for client rows. Pure additive redefinition.
--
-- CREATE OR REPLACE VIEW can only APPEND columns, never insert one mid-list or
-- reorder — inserting `is_first_visit` in the middle makes Postgres read it as
-- renaming an existing column and it fails (SQLSTATE 42P16). So it goes LAST,
-- after next2_session_at, keeping every prior column in its exact position.
-- The underlying column already exists (v3 schema migration).
-- security_invoker stays ON so RLS on the base tables still applies.

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
  c.is_first_visit
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

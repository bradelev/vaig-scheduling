-- Cuponeras — prepaid session packages (the internal booking plan
-- §"Cuponera"). External's pain: it asks for a deposit on EVERY session of a
-- treatment the client already paid. VAIG models the package from the start.
--
-- Model (decided 2026-08-27):
--   * A package PRODUCT is a booking_services item with package_sessions = N
--     (e.g. "Cuponera media pierna", 6). NULL = a single-session item.
--   * Buying it (first public reservation of that item, or the team by hand)
--     creates a client_packages row: total N, used 0/1, status pendiente_pago.
--     The team marks it pagada on day 1 (POS / transfer). The balance is
--     USABLE regardless of payment (the business decides at the desk).
--   * Each reservation of that item CONSUMES one credit atomically
--     (consume_package_credit) and links the session (sessions.package_id).
--     The balance is a STORED counter — never derived from session counts —
--     so no-shows / refunds are explicit team decisions (adjust_package_credit).
--   * Cancelling a linked session BEFORE it happens returns the credit (the
--     app does it). A session that already happened keeps its credit spent —
--     a no-show is simply a spent credit; ±1 in the panel is the override.
--
-- Session state (por confirmar / confirmada) and package state (pendiente_pago /
-- pagada) are independent.

alter table public.booking_services
  add column if not exists package_sessions smallint
    check (package_sessions is null or package_sessions >= 2);

comment on column public.booking_services.package_sessions is
  'Sessions included when this item is a prepaid package (cuponera); NULL for single-session items. Set by the team per item.';

create table public.client_packages (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references public.clients (id) on delete cascade,
  booking_service_id uuid not null references public.booking_services (id) on delete restrict,
  total_sessions     smallint not null check (total_sessions >= 1),
  used_sessions      smallint not null default 0,
  status             text not null default 'pendiente_pago'
                     check (status in ('pendiente_pago', 'pagada', 'cancelada')),
  paid_at            timestamptz,
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (used_sessions >= 0 and used_sessions <= total_sessions)
);

comment on table public.client_packages is
  'Prepaid packages (cuponeras): a stored credit balance per client and item. used_sessions is the ledger, never derived from sessions.';

-- The consume query: oldest open package of this client + item with credit left.
create index client_packages_open_idx
  on public.client_packages (client_id, booking_service_id, created_at)
  where status <> 'cancelada';

create trigger client_packages_set_updated_at
  before update on public.client_packages
  for each row execute function set_updated_at();

alter table public.client_packages enable row level security;
create policy staff_full_access on public.client_packages
  for all to authenticated using (is_staff()) with check (is_staff());

-- Which package a session drew its credit from (NULL for single sessions).
alter table public.sessions
  add column if not exists package_id uuid references public.client_packages (id) on delete set null;

create index sessions_package_idx
  on public.sessions (package_id)
  where package_id is not null;

-- Atomic credit consumption: take one credit from the oldest open package of
-- this client + item that still has credit; nothing when there is none.
-- Row-locked (FOR UPDATE, no SKIP LOCKED): a concurrent second caller WAITS
-- for the first to commit and then re-evaluates `used < total` on the new
-- row version — it gets the next credit, or nothing if that was the last one.
-- (SKIP LOCKED would make it skip the package and "buy" a phantom second one.)
create or replace function public.consume_package_credit(p_client uuid, p_service uuid)
returns table (id uuid, total_sessions smallint, used_sessions smallint)
language sql
as $$
  update public.client_packages cp
     set used_sessions = cp.used_sessions + 1
   where cp.id = (
     select c.id
       from public.client_packages c
      where c.client_id = p_client
        and c.booking_service_id = p_service
        and c.status <> 'cancelada'
        and c.used_sessions < c.total_sessions
      order by c.created_at
      limit 1
      for update)
  returning cp.id, cp.total_sessions, cp.used_sessions;
$$;

-- Explicit ledger moves: +1 (no-show taken by hand), -1 (credit returned).
-- Clamped to [0, total].
create or replace function public.adjust_package_credit(p_package uuid, p_delta integer)
returns table (id uuid, total_sessions smallint, used_sessions smallint)
language sql
as $$
  update public.client_packages cp
     set used_sessions = greatest(0, least(cp.total_sessions::integer, cp.used_sessions + p_delta))::smallint
   where cp.id = p_package
  returning cp.id, cp.total_sessions, cp.used_sessions;
$$;

-- Server-side only (the app calls them with the service role); never from
-- PostgREST as anon/authenticated.
revoke execute on function public.consume_package_credit(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.adjust_package_credit(uuid, integer) from public, anon, authenticated;
grant execute on function public.consume_package_credit(uuid, uuid) to service_role;
grant execute on function public.adjust_package_credit(uuid, integer) to service_role;

-- booking_catalog (2026-08-26): the priced item catalog for VAIG's own online
-- booking — the second half of Phase 1A (data model) of the online booking
-- plan (the internal booking plan). Schema only; the real 85-item
-- catalog is loaded in prod (business config, NOT committed — see the strategy
-- doc). Slot logic (1B) and UI (1C) come next.
--
-- WHY A NEW TABLE, not more rows in service_types:
--   service_types is the 7-row catalog of CATEGORIES (Depilación, HIFU, Botox…)
--   that `sessions.service` references and the validate_app_service() trigger
--   enforces. A booking ITEM ("axilas", "bozo + pierna entera") is a different
--   thing: a concrete, priced line a client reserves — 85 of them, many combos.
--   Folding items into service_types would (a) blur category vs item and (b)
--   make the trigger validate sessions.service against 90+ slugs, risking Nueva
--   sesión. So items get their own table with its OWN category grouping for the
--   "dropdown grande". (Braulio's call, 2026-08-26.)

-- 1. The priced booking items. One row per External service, combos included
--    (each combo is its own item with the discount already baked into its
--    price — VAIG shows the price, never computes discounts; PRD/strategy §c).
create table booking_services (
  id            uuid primary key default gen_random_uuid(),
  -- Human-facing name (Spanish), e.g. "Axilas", "Bozo + Pierna entera".
  name          text not null,
  -- Grouping label for the big dropdown, FREE TEXT (Spanish). Deliberately NOT
  -- a FK to service_types: service_types' 7 slugs are programmer-placed
  -- placeholders, while these ~20 categories are the REAL taxonomy the team
  -- (Cynthia + staff) curated in External — "Depilación Láser", "Day Spa",
  -- "Masaje Estético", "Nutrición"… They don't map onto the 7 slugs without
  -- losing the granularity the dropdown groups by, so the booking catalog owns
  -- its own category string. Nullable = uncategorized. (Braulio, 2026-08-26.)
  category      text,
  -- Price in whole Uruguayan pesos (no cents — VAIG only DISPLAYS it, the team
  -- adjusts the final charge). NULL = "a consultar" (External had display-only
  -- prices for some). Non-negative when present.
  price_uyu     integer check (price_uyu is null or price_uyu >= 0),
  -- Deposit / seña required to hold the online reservation, whole pesos
  -- (External's payable_at_reservation). 0 = no deposit. Cuponera clients pay no
  -- deposit regardless (enforced later in the booking flow, not here).
  deposit_uyu   integer not null default 0 check (deposit_uyu >= 0),
  -- How long the appointment blocks the calendar, minutes. The slot engine (1B)
  -- reads this. Positive. (External's duration, with obvious garbage corrected at
  -- load time — e.g. the "Hifu en abdomen 4hs" row whose duration was 10240.)
  duration_min  integer not null check (duration_min > 0),
  active        boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index booking_services_category_idx
  on booking_services (category) where category is not null;
create index booking_services_active_idx
  on booking_services (active) where active;

-- 2. Which staff member provides which item, and in what PRIORITY order. When a
--    client picks "con quien sea", the booking flow assigns the lowest-priority
--    number first (1 = tried first). Cynthia is kept out of the operational pool
--    by giving her a HIGH number (last), but she stays in the table so clients
--    who want her can still pick her directly (Braulio, 2026-08-26).
create table staff_services (
  staff_id           text not null references staff(id) on delete cascade,
  booking_service_id uuid not null references booking_services(id) on delete cascade,
  -- Lower = assigned first for "con quien sea". Default 100 = "no preference set".
  priority           smallint not null default 100,
  created_at         timestamptz not null default now(),
  primary key (staff_id, booking_service_id)
);

-- Look up "who does this item, best first" for the auto-assign path.
create index staff_services_by_item_idx
  on staff_services (booking_service_id, priority);

-- Keep updated_at fresh on booking_services (reuses set_updated_at() from
-- migration 20260807233345, same as staff / staff_hours).
drop trigger if exists set_updated_at on booking_services;
create trigger set_updated_at
  before update on booking_services
  for each row execute function set_updated_at();

-- RLS: same single-level policy as staff / staff_hours — authenticated staff
-- full access, anon nothing; service_role bypasses RLS but needs the grant.
-- (Public/anon read for the client-facing booking page is a SEPARATE, narrower
-- policy added in the public-booking phase, not here — this table is admin-only
-- until then.)
alter table booking_services enable row level security;
create policy staff_full_access on booking_services
  for all to authenticated using (true) with check (true);
grant all on table booking_services to authenticated, service_role;
revoke all on table booking_services from anon;

alter table staff_services enable row level security;
create policy staff_full_access on staff_services
  for all to authenticated using (true) with check (true);
grant all on table staff_services to authenticated, service_role;
revoke all on table staff_services from anon;

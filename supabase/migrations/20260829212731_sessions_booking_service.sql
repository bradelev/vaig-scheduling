-- Public online booking (Phase 2): link a session to the catalog item it was
-- booked for. The public write already stores the item's category as
-- sessions.service (a service_types slug) and the item's name in the note,
-- but the panel ("por confirmar" list, the confirmation message) needs the
-- item itself — its name for the client-facing copy, its category for the
-- preparation instruction — and the cuponera ledger (Phase 3) will need to
-- charge the right item. Parsing the note would be fragile; a FK is not.
--
-- Nullable: staff-created and calendar-origin sessions have no catalog item.
-- ON DELETE SET NULL: retiring an item must never delete or block sessions.
alter table public.sessions
  add column if not exists booking_service_id uuid
    references public.booking_services (id) on delete set null;

comment on column public.sessions.booking_service_id is
  'Catalog item (booking_services) this session was booked for — set by the public booking write; NULL for staff/calendar sessions.';

create index if not exists sessions_booking_service_idx
  on public.sessions (booking_service_id)
  where booking_service_id is not null;

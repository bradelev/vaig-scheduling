-- Public online booking (Phase 2, the internal booking plan §"Reservas por
-- confirmar"): a reservation made by a client on the public page is born
-- "por confirmar" — the business confirms it (or reschedules / cancels) from
-- the panel before it counts as a firm appointment.
--
-- WHY A NEW COLUMN and not confirmed_at NULL: confirmed_at already means
-- "the CLIENT confirmed attendance" (send-reminders selects
-- status='scheduled' AND confirmed_at IS NULL to send the reminder, and the
-- wa-webhook sets confirmed_at when the client taps "Confirmar"). Reusing it
-- would make the reminder cron message an unconfirmed reservation and let the
-- client's tap "confirm" a reservation staff never saw. Staff confirmation is
-- a separate state, so it gets its own flag.
--
-- Semantics:
--   pending_confirmation = true  → "por confirmar": staff must act. The row is
--     a real session (blocks the slot via sessions_no_overlap, shows on the
--     agenda) but is NOT reminded and NOT mirrored to Google Calendar yet.
--   pending_confirmation = false → normal session (default; every existing row).
-- Staff confirming clears the flag (and triggers the calendar mirror); the
-- reminder pipeline then treats it like any app session.
alter table public.sessions
  add column if not exists pending_confirmation boolean not null default false;

comment on column public.sessions.pending_confirmation is
  'Public-booking reservation awaiting STAFF confirmation. Distinct from confirmed_at (client confirmed attendance). Excluded from reminders and the calendar mirror while true.';

-- The "por confirmar" panel list reads exactly the pending rows, by start time.
create index if not exists sessions_pending_confirmation_idx
  on public.sessions (starts_at)
  where pending_confirmation;

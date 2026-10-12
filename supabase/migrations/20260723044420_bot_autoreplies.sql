-- 0007_bot_autoreplies (issue #74): rate-limit state for the fixed
-- auto-redirect the bot sends when someone writes free text to it (the
-- bot number has no inbox — without this, clients talk into a void).
-- One row per sender phone; the webhook replies at most once per 24h.
--
-- Written by the service role only (edge function). RLS on with no
-- policies: staff/anon never read it — phones of NON-clients can land
-- here too, so the table stays out of every user-facing surface.

create table bot_autoreplies (
  phone       text primary key,
  replied_at  timestamptz not null default now()
);

alter table bot_autoreplies enable row level security;

grant all on table bot_autoreplies to service_role;
-- Defense in depth, matching the init-migration precedent: the linked
-- v1-era project may auto-grant new tables to the Data API roles, and this
-- table can hold phones of NON-clients.
revoke all on table bot_autoreplies from anon, authenticated;

-- evening_reminder_catchup (2026-08-21): a SECOND reminder batch at 21:00
-- America/Montevideo to close the 24h hole.
--
-- The problem: the daily batch runs once at 16:00 and reminds the whole NEXT
-- Montevideo day. A session for tomorrow that appears AFTER 16:00 today — most
-- often via the hourly calendar sync (a External booking or a hand-typed event),
-- which the in-app CRUD's immediate-reminder does NOT cover — never gets its
-- (single) reminder: today's 16:00 batch already ran, and tomorrow's batch
-- looks at the day after. The "sin recordatorio enviado" panel surfaces these
-- for manual follow-up; this batch catches most of them automatically.
--
-- Why this is safe to add (no double sends): send-reminders is idempotent —
-- it only selects sessions with reminder_sent_at IS NULL and enforces one
-- reminder per client per Montevideo day. So this 21:00 run skips everyone the
-- 16:00 batch already reminded and only catches the newcomers. Same window
-- function (nextLocalDayWindow) — at 21:00 MVD it's still "today" locally, so
-- the window is still tomorrow.
--
-- 21:00 America/Montevideo = 00:00 UTC (Uruguay abolished DST in 2015, fixed
-- -03:00). pg_cron runs in UTC. Same Vault-resolved job body as the 16:00 job:
-- URL and key are read AT RUN TIME, so this applies cleanly on CI's ephemeral
-- stack.

-- Guard the unschedule so re-applying (or CI) is idempotent.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'send-reminders-evening') then
    perform cron.unschedule('send-reminders-evening');
  end if;
end
$$;

select cron.schedule(
  'send-reminders-evening',
  '0 0 * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets
            where name = 'project_url') || '/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret
                                     from vault.decrypted_secrets
                                     where name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $job$
);

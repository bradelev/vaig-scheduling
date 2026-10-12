-- 0008_reschedule_send_reminders_16h (issue #78): move the daily reminder
-- batch to 16:00 America/Montevideo = 19:00 UTC (go-live decision, Braulio
-- 2026-07-23). Uruguay abolished DST in 2015, so a fixed UTC hour is
-- correct year-round; pg_cron runs in UTC. The window logic moved with it:
-- each 16:00 run covers the whole NEXT Montevideo calendar day (FR-2).
--
-- In prod the job is currently UNSCHEDULED (rehearsal mode, issue #60), so
-- this migration doubles as the go-live re-scheduling. Same Vault-resolved
-- job body as migration 0003: URL and key are read AT RUN TIME, so the
-- migration applies cleanly on CI's ephemeral stack.

-- Guard the unschedule: the job exists on CI (migration 0003 scheduled it)
-- but not in prod right now.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'send-reminders-daily') then
    perform cron.unschedule('send-reminders-daily');
  end if;
end
$$;

select cron.schedule(
  'send-reminders-daily',
  '0 19 * * *',
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

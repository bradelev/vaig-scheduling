-- 0003_cron_send_reminders (PRD FR-2, §5): daily reminder batch.
-- 10:00 America/Montevideo = 13:00 UTC. Uruguay abolished DST in 2015,
-- so a fixed UTC hour is correct year-round; pg_cron runs in UTC.
--
-- The job body resolves the project URL and the service key from Vault
-- AT RUN TIME, so this migration applies cleanly on CI's ephemeral stack
-- (no secrets there — the job would just fail if it ever executed).
-- [HUMAN] prod prerequisite (tracked in issue #3): create the Vault
-- secrets `project_url` and `service_role_key` in the dashboard.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Migrations run once, but guard the name so a manual re-apply never errors.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'send-reminders-daily') then
    perform cron.unschedule('send-reminders-daily');
  end if;
end
$$;

select cron.schedule(
  'send-reminders-daily',
  '0 13 * * *',
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

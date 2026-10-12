-- 0004_cron_sync_calendar (PRD FR-1, §5): hourly calendar sync.
-- Runs at minute 0 of every hour (pg_cron is UTC; the sync itself does no
-- local-time math). Same pattern as the send-reminders cron: URL and key
-- resolve from Vault at run time, so this applies cleanly on CI's secretless
-- stack.
-- [HUMAN] prod prerequisite (tracked in issue #3): the Vault secrets
-- `project_url` and `service_role_key` must exist (created for the
-- send-reminders cron; reused here).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Guard the name so a manual re-apply never errors.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-calendar-hourly') then
    perform cron.unschedule('sync-calendar-hourly');
  end if;
end
$$;

select cron.schedule(
  'sync-calendar-hourly',
  '0 * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets
            where name = 'project_url') || '/functions/v1/sync-calendar',
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

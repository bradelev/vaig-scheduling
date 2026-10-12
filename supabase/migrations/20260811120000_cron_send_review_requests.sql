-- Cron for send-review-requests (PRD §III, layer 3): daily review-ask batch.
-- 13:00 America/Montevideo = 16:00 UTC. Uruguay abolished DST in 2015, so a
-- fixed UTC hour is correct year-round; pg_cron runs in UTC.
--
-- The job asks loyal clients (3+ completed sessions, never reviewed, not opted
-- out) for a Google review the day AFTER their session. Idempotent on
-- clients.review_requested_at, so a re-run never double-asks.
--
-- Same pattern as 0003_cron_send_reminders: the job body resolves the project
-- URL and service key from Vault AT RUN TIME, so this applies cleanly on CI's
-- ephemeral stack (no secrets there — the job would just fail if it executed).
-- [HUMAN] prod prerequisite: the Vault secrets `project_url` and
-- `service_role_key` already exist (created for send-reminders).

-- pg_cron / pg_net are already installed by the reminders cron migration;
-- create-if-not-exists keeps this idempotent on a standalone apply.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Guard the name so a manual re-apply never errors.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'send-review-requests-daily') then
    perform cron.unschedule('send-review-requests-daily');
  end if;
end
$$;

select cron.schedule(
  'send-review-requests-daily',
  '0 16 * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets
            where name = 'project_url') || '/functions/v1/send-review-requests',
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

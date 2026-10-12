-- Per-IP rate limiting for the public surface (docs/TECH_DEBT.md 2026-08-28 /
-- 2026-08-30): request-code, verify-code, /api/reservar and the public
-- availability read. A fixed-window counter in Postgres — shared by every
-- serverless instance (an in-memory bucket isn't), no new infrastructure, and
-- atomic through one upsert. Defense in depth: the per-phone OTP limits and
-- the per-client pending cap remain the strong gates; this bounds cost and
-- brute force from one source. The forwarded IP is spoofable at the edge, so
-- this is never the only control.
--
-- Service-role only: the app calls rate_limit_hit with the service client;
-- anon/authenticated can't read the table nor execute the function.

create table public.rate_limits (
  -- "<scope>:<ip>", e.g. "request-code:203.0.113.7"
  key          text primary key,
  window_start timestamptz not null default now(),
  hits         integer not null default 0
);

comment on table public.rate_limits is
  'Fixed-window per-IP counters for the public endpoints; rows are transient (reset per window, swept opportunistically).';

alter table public.rate_limits enable row level security;
grant all on table public.rate_limits to service_role;
revoke all on table public.rate_limits from anon, authenticated;

-- One hit for `p_key`. Starts a new window when the previous one expired;
-- otherwise counts. Allowed while hits <= p_limit. When refused, returns the
-- seconds until the window resets (so the app can send Retry-After).
create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window_sec integer)
returns table (allowed boolean, retry_after_sec integer)
language plpgsql
set search_path = ''
as $$
declare
  r      public.rate_limits%rowtype;
  v_now  timestamptz := now();
  v_span interval := make_interval(secs => p_window_sec);
begin
  insert into public.rate_limits as rl (key, window_start, hits)
  values (p_key, v_now, 1)
  on conflict (key) do update
    set window_start = case when rl.window_start + v_span <= v_now then v_now else rl.window_start end,
        hits         = case when rl.window_start + v_span <= v_now then 1     else rl.hits + 1     end
  returning rl.* into r;

  -- Opportunistic sweep of long-dead windows (about 1 call in 200).
  if random() < 0.005 then
    delete from public.rate_limits where window_start < v_now - interval '2 days';
  end if;

  if r.hits <= p_limit then
    return query select true, 0;
  else
    return query select
      false,
      greatest(1, ceil(extract(epoch from (r.window_start + v_span - v_now)))::integer);
  end if;
end;
$$;

revoke execute on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

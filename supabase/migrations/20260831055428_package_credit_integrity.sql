-- Cuponera ledger integrity (recorded debt from the Phase 2 cuponera slice).
--
-- 1) REFUND ON CANCEL, EVERY PATH. The app's cancel actions refunded a future
--    session's package credit in application code — but sync-calendar also
--    flips sessions to 'cancelled' (a 🌸 event deleted straight from Google
--    Calendar) and that path silently ATE the credit. Moving the refund into a
--    row trigger makes every cancellation path (app action, sync tombstone,
--    manual SQL) refund exactly once, on the transition INTO 'cancelled'; the
--    app-side refund is removed in the same PR so nothing refunds twice.
--
--    Rules preserved from the app logic:
--      * only FUTURE sessions refund (a past no-show keeps the credit spent;
--        the panel's ±1 stays the manual override);
--      * clamp at 0 (never negative);
--      * refund fires only on the scheduled→cancelled TRANSITION, so repeated
--        cancelled writes are no-ops. Known edge, accepted: if a calendar
--        event is deleted, restored, and deleted again (un-cancel + re-cancel
--        of the same future session), the credit refunds once per transition —
--        rare, bounded by the clamp, correctable with the panel's ±1.
--      * hard DELETE of sessions is not a path the app has; no DELETE trigger.
create function refund_package_credit_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.package_id is not null and new.starts_at > now() then
    update public.client_packages
      set used_sessions = greatest(used_sessions - 1, 0)
      where id = new.package_id;
  end if;
  return new;
end;
$$;

create trigger sessions_refund_package_credit
after update of status on sessions
for each row
when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
execute function refund_package_credit_on_cancel();

-- 2) ATOMIC CONSUME-OR-CREATE (anti concurrent double purchase). Two
--    concurrent public reservations of a package item, same client, no
--    existing credit, could BOTH see "no credit" and each create a package:
--    FOR UPDATE can't serialize the empty case (there is no row to lock yet).
--    A per-(client, service) transaction advisory lock closes exactly that
--    hole: the second caller waits for the first to commit, then finds the
--    freshly created package and takes its next credit instead of creating a
--    phantom second one.
--
--    Consume semantics are IDENTICAL to consume_package_credit (oldest open
--    non-cancelled package with credit, FOR UPDATE); that function stays for
--    callers that must never create. A partial unique index was considered
--    and rejected: any predicate narrow enough to allow legitimate sales
--    collides with the refund trigger re-opening an exhausted package.
create function public.take_package_credit(p_client uuid, p_service uuid, p_total smallint)
returns table (id uuid, total_sessions smallint, used_sessions smallint, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.client_packages%rowtype;
begin
  -- Two-arg form keys the lock on (class 8231, per-pair hash): scoped enough
  -- that unrelated (client, service) pairs almost never contend, and a rare
  -- hash collision only costs a moment of serialization, never correctness.
  perform pg_advisory_xact_lock(8231, hashtext(p_client::text || ':' || p_service::text));

  update public.client_packages cp
     set used_sessions = cp.used_sessions + 1
   where cp.id = (
     select c.id
       from public.client_packages c
      where c.client_id = p_client
        and c.booking_service_id = p_service
        and c.status <> 'cancelada'
        and c.used_sessions < c.total_sessions
      order by c.created_at
      limit 1
      for update)
  returning cp.* into v_row;

  if found then
    return query select v_row.id, v_row.total_sessions, v_row.used_sessions, false;
    return;
  end if;

  insert into public.client_packages (client_id, booking_service_id, total_sessions, used_sessions, status)
  values (p_client, p_service, p_total, 1, 'pendiente_pago')
  returning * into v_row;
  return query select v_row.id, v_row.total_sessions, v_row.used_sessions, true;
end;
$$;

-- Server-side only (the reserve flow calls it with the service role).
revoke execute on function public.take_package_credit(uuid, uuid, smallint) from public, anon, authenticated;
grant execute on function public.take_package_credit(uuid, uuid, smallint) to service_role;

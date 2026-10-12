-- no_double_booking (2026-08-28): a DB-level guard against two sessions for the
-- SAME professional overlapping in time (Phase 2 of the public-booking plan —
-- the sharpest technical risk in the plan). Without this, a read-then-insert in
-- the booking endpoint races: two clients checking the same slot in the same
-- second both see it free and both insert. An exclusion constraint makes the
-- check atomic in the DB — the second overlapping insert is rejected, always.
--
-- ⚠️ APPLY-TIME RISK (prod is human): ADD CONSTRAINT ... EXCLUDE validates
-- against EXISTING rows and CANNOT be NOT VALID (Postgres forbids that for
-- exclusion constraints). If prod already has two app sessions with the same
-- attended_by overlapping (Nueva sesión has no guard today, so an operator
-- COULD have double-booked), this migration FAILS to apply. BEFORE db push, run
-- the overlap-detection query handed off with this migration; resolve any hits
-- (cancel / reassign / adjust) so the query returns 0 rows, then apply.
--
-- COUPLING NOTE: the slot engine's busy query also excludes dismissed_at rows
-- (availability.ts), which this constraint does not. That's safe only because
-- dismissMatchedSession is gated to source <> 'app', and only source='app' rows
-- carry attended_by — so a dismissed row always has attended_by=null and falls
-- outside this constraint's WHERE. If a future change ever lets an attended_by
-- row be dismissed, the DB would reject a slot the engine offers. Keep the
-- invariant "dismissible ⟺ attended_by is null".
--
-- Scope: only sessions with a professional assigned (attended_by not null) and
-- not cancelled. External/manual rows and unassigned app rows are unconstrained
-- (they carry no attended_by, or the slot engine doesn't own their calendar).
--
-- ends_at is NULLABLE: the slot engine treats a null-end session as 60 min
-- long (FALLBACK_BUSY_MINUTES). The range here matches that so the DB guard and
-- the engine agree — a null-end session occupies [starts_at, starts_at+60min).

-- btree_gist lets an exclusion constraint mix an equality operator (=, on the
-- text attended_by) with a range-overlap operator (&&, on the tstzrange).
create extension if not exists btree_gist;

-- The time range a session occupies. Postgres won't accept a bare
-- `tstzrange(starts_at, coalesce(...), '[)')` in the exclusion index — it treats
-- tstzrange(timestamptz,...) as STABLE (not provably IMMUTABLE), and index
-- expressions must be IMMUTABLE (SQLSTATE 42P17). tstzrange over timestamptz IS
-- deterministic for range comparison (timestamptz is an absolute instant), so
-- wrapping it in a function explicitly marked IMMUTABLE is the standard, safe
-- pattern. coalesce mirrors the engine's null-end fallback (60 minutes); '[)' =
-- end-exclusive, so back-to-back (one ends exactly when the next starts) is not
-- an overlap — matching the engine's half-open interval math.
create function session_time_range(starts_at timestamptz, ends_at timestamptz)
returns tstzrange
language sql
immutable
set search_path = ''
as $$
  select tstzrange(
    starts_at,
    coalesce(ends_at, starts_at + interval '60 minutes'),
    '[)'
  );
$$;

alter table sessions
  add constraint sessions_no_overlap
  exclude using gist (
    attended_by with =,
    session_time_range(starts_at, ends_at) with &&
  )
  where (attended_by is not null and status <> 'cancelled');

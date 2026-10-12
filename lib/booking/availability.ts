/**
 * Availability query layer (Phase 1B). The thin I/O around the pure slot engine
 * (./slots): reads a staff member's working-hour rules and their booked sessions
 * from Supabase, then asks computeDaySlots() for the free slots per local day.
 *
 * Kept deliberately small and logic-free — all the real decisions (union,
 * subtract, grid, timezone) live in ./intervals + ./slots, which are unit-
 * tested. This module just fetches rows and loops days, so it needs only an
 * integration test (a live DB), not a unit test.
 *
 * Node-only (imports the slot engine + a Supabase client). Not a Server Action
 * itself; a plain module the Nueva-sesión server code / a future booking route
 * can call.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeDaySlots,
  localDayKey,
  type HourRule,
  type BusyInterval,
  type Slot,
} from "./slots";

/** Default grid spacing between offered starts, in minutes. */
export const DEFAULT_STEP_MIN = 30;

/** One local day plus its available slots (empty array = nothing free). */
export type DayAvailability = { dayKey: string; slots: Slot[] };

export type AvailabilityQuery = {
  staffId: string;
  /** Appointment length (from booking_services.duration_min). */
  durationMin: number;
  /** First local day to consider, YYYY-MM-DD. */
  fromDayKey: string;
  /** Number of consecutive local days to compute (inclusive of fromDayKey). */
  days: number;
  /** Grid spacing; defaults to DEFAULT_STEP_MIN. */
  stepMin?: number;
  /** "Now" instant (ms) so past slots on the first day are dropped. */
  nowMs: number;
};

/** Enumerate `days` consecutive local day keys starting at `fromDayKey`. */
function dayKeyRange(fromDayKey: string, days: number): string[] {
  const keys: string[] = [];
  // Anchor at local noon to stay unambiguously inside each day, then step 24h.
  let ms = new Date(`${fromDayKey}T12:00:00-03:00`).getTime();
  for (let i = 0; i < days; i++) {
    keys.push(localDayKey(ms));
    ms += 24 * 60 * 60 * 1000;
  }
  return keys;
}

/**
 * Compute a staff member's free slots across a local-day window.
 *
 * Reads two things:
 *  - staff_hours rules for the staff (all kinds; the engine filters per day).
 *  - their busy sessions: source-agnostic (external/manual/app all block the
 *    calendar), status <> 'cancelled', not dismissed, overlapping the window.
 */
export async function getStaffAvailability(
  db: SupabaseClient,
  q: AvailabilityQuery,
): Promise<DayAvailability[]> {
  const dayKeys = dayKeyRange(q.fromDayKey, q.days);
  if (dayKeys.length === 0) return [];

  // Window bounds as instants: [start of first day, end of last day) local.
  const windowStart = new Date(`${dayKeys[0]}T00:00:00-03:00`).toISOString();
  const lastDay = dayKeys[dayKeys.length - 1];
  const windowEndMs =
    new Date(`${lastDay}T00:00:00-03:00`).getTime() + 24 * 60 * 60 * 1000;
  const windowEnd = new Date(windowEndMs).toISOString();

  const [rulesRes, busyRes] = await Promise.all([
    db
      .from("staff_hours")
      .select("kind, weekday, on_date, start_min, end_min")
      .eq("staff_id", q.staffId),
    db
      .from("sessions")
      .select("starts_at, ends_at")
      .eq("attended_by", q.staffId)
      .neq("status", "cancelled")
      .is("dismissed_at", null)
      // Overlaps the window. A session overlaps iff it starts before the window
      // ends AND ends after the window starts. But ends_at can be NULL (synced
      // rows with an unknown end) — `NULL > x` is unknown in SQL, which would
      // silently drop a REAL booking and let us double-book it. So we keep every
      // row that starts before the window ends, and additionally require either
      // ends_at IS NULL (engine gives it a fallback length) or ends_at after the
      // window start. Over-fetching a NULL-end row that starts inside the window
      // but is actually far in the past is harmless — the engine clips per day.
      .lt("starts_at", windowEnd)
      .or(`ends_at.gt.${windowStart},ends_at.is.null`),
  ]);

  if (rulesRes.error) {
    throw new Error(`Could not read staff hours: ${rulesRes.error.message}`);
  }
  if (busyRes.error) {
    throw new Error(`Could not read sessions: ${busyRes.error.message}`);
  }

  const rules = (rulesRes.data ?? []) as HourRule[];
  const busy = (busyRes.data ?? []) as BusyInterval[];
  const stepMin = q.stepMin ?? DEFAULT_STEP_MIN;

  return dayKeys.map((dayKey) => ({
    dayKey,
    slots: computeDaySlots({
      dayKey,
      rules,
      busy,
      durationMin: q.durationMin,
      stepMin,
      nowMs: q.nowMs,
    }),
  }));
}

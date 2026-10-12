/**
 * Slot engine — timezone layer (Phase 1B of the online booking plan).
 * Turns a staff member's working-hour rules + their already-booked sessions into
 * the concrete free start times for an appointment of a given length, on a given
 * local day. Builds on the pure interval algebra in ./intervals.
 *
 * TIMEZONE (the crux). The whole codebase treats America/Montevideo as a FIXED
 * -03:00 offset (Uruguay abolished DST in 2015), and has no date library. We
 * follow the two established primitives verbatim:
 *   • instant → local wall-clock: Intl.DateTimeFormat({ timeZone: "America/
 *     Montevideo" }) (same as lib/clients/status.ts).
 *   • local wall-clock → instant: the string template
 *     new Date(`${YYYY-MM-DD}T${HH:MM}:00-03:00`) (same as status.ts / reminders).
 * `staff_hours` stores minutes-from-local-midnight; sessions store timestamptz
 * instants. We convert both into local-minute Intervals for one day, do the
 * algebra there, then convert the resulting start minutes BACK to instants.
 *
 * PURITY: this module does NO database I/O. It takes rows already fetched (so it
 * unit-tests with invented data and an injected `now`). The thin query layer
 * that reads staff_hours/sessions lives in ./availability.ts.
 */
import { normalize, union, subtract, slotStarts, type Interval } from "./intervals";

/** One working-hour rule row from staff_hours (only the fields the math needs). */
export type HourRule =
  | { kind: "weekly"; weekday: number; start_min: number; end_min: number }
  | { kind: "open"; on_date: string; start_min: number; end_min: number }
  // A 'block' may be all-day (start/end null) or a partial range.
  | { kind: "block"; on_date: string; start_min: number | null; end_min: number | null };

/** An already-booked session that makes a staff member busy (instants, ISO). */
export type BusyInterval = { starts_at: string; ends_at: string | null };

const MINUTES_IN_DAY = 1440;

/**
 * Fallback length (minutes) for a booked session whose ends_at is NULL. Synced
 * external/manual sessions can have a timed start but a missing/date-only end
 * (sync-calendar stores ends_at=null), yet they are REAL busy time — treating
 * them as zero-length would offer their exact slot and double-book. 60 is the
 * repo's established default for a missing end (calendar-write's mirrorEnd).
 */
export const FALLBACK_BUSY_MINUTES = 60;

/** Montevideo calendar day (YYYY-MM-DD) for an instant. Same as status.ts. */
export function localDayKey(instantMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instantMs));
}

/**
 * The staff_hours weekday (0=Sunday..6=Saturday) for a YYYY-MM-DD local day.
 * We anchor the day at local noon (`T12:00:00-03:00`) so the instant is
 * unambiguously inside that calendar day, then ask Intl for the weekday. Noon,
 * not midnight, to leave no doubt even if an offset ever shifted by an hour.
 */
export function localWeekday(dayKey: string): number {
  const noon = new Date(`${dayKey}T12:00:00-03:00`);
  // en-US 'short' weekday → map to the 0..6 Sunday-based index staff_hours uses.
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Montevideo",
    weekday: "short",
  }).format(noon);
  const idx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  return idx; // -1 only if Intl returned something unexpected; callers pass real days
}

/** Convert a start-minute on a local day to an ISO instant (fixed -03:00). */
export function localMinuteToInstant(dayKey: string, minute: number): string {
  const hh = String(Math.floor(minute / 60)).padStart(2, "0");
  const mm = String(minute % 60).padStart(2, "0");
  return new Date(`${dayKey}T${hh}:${mm}:00-03:00`).toISOString();
}

/**
 * Project one busy session onto a local day as a minute Interval, CLIPPED to
 * [0,1440]. A session that starts the day before and runs into this day (or
 * spills past midnight) is clipped to the part that lands on `dayKey`. Sessions
 * with no overlap on the day return null. A NULL ends_at is NOT free time: it's
 * a real booking with an unknown end (synced external/manual rows), so we treat
 * it as FALLBACK_BUSY_MINUTES long from its start — never zero-length, or we'd
 * offer the very slot it occupies and double-book.
 */
export function busyToLocalInterval(
  busy: BusyInterval,
  dayKey: string,
): Interval | null {
  const dayStartMs = new Date(`${dayKey}T00:00:00-03:00`).getTime();
  const dayEndMs = dayStartMs + MINUTES_IN_DAY * 60_000;
  const s = new Date(busy.starts_at).getTime();
  const e = busy.ends_at
    ? new Date(busy.ends_at).getTime()
    : s + FALLBACK_BUSY_MINUTES * 60_000;
  if (!(s < e)) return null; // zero/negative length
  const clippedStart = Math.max(s, dayStartMs);
  const clippedEnd = Math.min(e, dayEndMs);
  if (clippedStart >= clippedEnd) return null; // no overlap with this day
  const startMin = Math.floor((clippedStart - dayStartMs) / 60_000);
  const endMin = Math.ceil((clippedEnd - dayStartMs) / 60_000);
  return { start: startMin, end: endMin };
}

/**
 * Availability intervals (in local minutes) for `dayKey`, from the rules:
 *   (weekly rules for that weekday) ∪ (open rules for that date).
 * Blocks are applied by the caller (computeDaySlots) via subtract.
 */
export function availabilityForDay(dayKey: string, rules: HourRule[]): Interval[] {
  const weekday = localWeekday(dayKey);
  const weekly: Interval[] = [];
  const open: Interval[] = [];
  for (const r of rules) {
    if (r.kind === "weekly" && r.weekday === weekday) {
      weekly.push({ start: r.start_min, end: r.end_min });
    } else if (r.kind === "open" && r.on_date === dayKey) {
      open.push({ start: r.start_min, end: r.end_min });
    }
  }
  return union(weekly, open);
}

/** Block intervals (local minutes) for `dayKey`. All-day block → whole day. */
export function blocksForDay(dayKey: string, rules: HourRule[]): Interval[] {
  const blocks: Interval[] = [];
  for (const r of rules) {
    if (r.kind !== "block" || r.on_date !== dayKey) continue;
    if (r.start_min == null || r.end_min == null) {
      blocks.push({ start: 0, end: MINUTES_IN_DAY }); // closed all day
    } else {
      blocks.push({ start: r.start_min, end: r.end_min });
    }
  }
  return normalize(blocks);
}

export type DaySlotsInput = {
  /** Local day YYYY-MM-DD. */
  dayKey: string;
  /** All staff_hours rules for the staff member (any kind; filtered here). */
  rules: HourRule[];
  /** The staff member's busy (non-cancelled) sessions overlapping the day. */
  busy: BusyInterval[];
  /** Appointment length from booking_services.duration_min. */
  durationMin: number;
  /** Grid spacing between offered starts (minutes). */
  stepMin: number;
  /** "Now" as an instant (ms) — starts at or before now are dropped. Optional:
   *  when omitted, no past-filtering (useful for pure day math in tests). */
  nowMs?: number;
};

/** A single offered slot: the start instant and its length. */
export type Slot = { startsAt: string; durationMin: number };

/**
 * The free slots for one staff member on one local day. Pipeline:
 *   free = availability − blocks − busy   (all in local minutes)
 *   starts = grid points where the duration fits
 *   → each start minute back to an ISO instant, past ones dropped.
 */
export function computeDaySlots(input: DaySlotsInput): Slot[] {
  const { dayKey, rules, busy, durationMin, stepMin, nowMs } = input;
  const avail = availabilityForDay(dayKey, rules);
  if (avail.length === 0) return [];
  const blocks = blocksForDay(dayKey, rules);
  const busyIntervals = busy
    .map((b) => busyToLocalInterval(b, dayKey))
    .filter((x): x is Interval => x !== null);

  const free = subtract(avail, [...blocks, ...busyIntervals]);
  const starts = slotStarts(free, durationMin, stepMin);

  const slots: Slot[] = [];
  for (const minute of starts) {
    const startsAt = localMinuteToInstant(dayKey, minute);
    if (nowMs !== undefined && new Date(startsAt).getTime() <= nowMs) continue;
    slots.push({ startsAt, durationMin });
  }
  return slots;
}

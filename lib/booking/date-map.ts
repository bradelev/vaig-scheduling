/**
 * Pure builder for the DATE map — a real calendar view of the coming days for
 * one staff member. Unlike the weekly PATTERN map, this shows
 * concrete dates (31/8, 1/9, …) with the ACTUAL availability of each day, so the
 * imported per-date External rules show up, and it also paints already-booked
 * sessions. No I/O; unit-tested. The thin query lives in date-map-actions.ts.
 *
 * Per half-hour cell, a day is one of:
 *   - 'booked'    : a session occupies it (takes priority — it's busy time)
 *   - 'available' : inside (weekly ∪ open) − block, and not booked
 *   - 'off'       : neither available nor booked (closed / not working)
 * This mirrors the slot engine's own math (availabilityForDay − blocks − busy),
 * just rasterized to cells for display instead of cut into slots.
 */
import type { Interval } from "./intervals";
import {
  availabilityForDay,
  blocksForDay,
  busyToLocalInterval,
  localDayKey,
  type HourRule,
  type BusyInterval,
} from "./slots";
import { subtract } from "./intervals";

export const CELL_MIN = 30;

/** Days shown per page (one week) of the date map. */
export const DATE_MAP_DAYS = 7;

export type CellState = "off" | "available" | "booked";

export type DateColumn = {
  /** "YYYY-MM-DD" (Montevideo). */
  dayKey: string;
  /** cell state keyed by row-start minute. */
  cells: Record<number, CellState>;
};

export type DateMap = {
  /** Row start minutes, ascending. */
  rowMins: number[];
  /** The columns, one per day in the window, in order. */
  columns: DateColumn[];
  startMin: number;
  endMin: number;
};

const DEFAULT_START = 8 * 60; // 08:00
const DEFAULT_END = 20 * 60; // 20:00

function floorToCell(m: number): number {
  return Math.floor(m / CELL_MIN) * CELL_MIN;
}
function ceilToCell(m: number): number {
  return Math.ceil(m / CELL_MIN) * CELL_MIN;
}

/** Does any interval in `set` overlap the cell [rowMin, rowMin+CELL)? */
function overlapsCell(set: Interval[], rowMin: number): boolean {
  const cellEnd = rowMin + CELL_MIN;
  return set.some((iv) => iv.start < cellEnd && iv.end > rowMin);
}

export type DateMapInput = {
  /** First local day, "YYYY-MM-DD". */
  fromDayKey: string;
  /** Number of consecutive days to show. */
  days: number;
  /** All staff_hours rules for the person (any kind). */
  rules: HourRule[];
  /** Their non-cancelled sessions overlapping the window. */
  busy: BusyInterval[];
};

/**
 * Build the date map. The visible row window spans the union of all days'
 * availability + booked spans (snapped to the cell grid), or a default
 * 08:00–20:00 when there's nothing. Booked beats available beats off per cell.
 */
export function buildDateMap(input: DateMapInput): DateMap {
  const { fromDayKey, days, rules, busy } = input;

  // Enumerate day keys from local noon, stepping 24h (fixed -03:00, no DST).
  const dayKeys: string[] = [];
  let ms = new Date(`${fromDayKey}T12:00:00-03:00`).getTime();
  for (let i = 0; i < days; i++) {
    dayKeys.push(localDayKey(ms));
    ms += 24 * 60 * 60 * 1000;
  }

  // Per day: available intervals (avail − block) and booked intervals.
  const perDay = dayKeys.map((dayKey) => {
    const avail = availabilityForDay(dayKey, rules);
    const blocks = blocksForDay(dayKey, rules);
    const available = subtract(avail, blocks);
    const booked = busy
      .map((b) => busyToLocalInterval(b, dayKey))
      .filter((x): x is Interval => x !== null);
    return { dayKey, available, booked };
  });

  // Window = min start / max end across every interval on every day.
  let startMin = Infinity;
  let endMin = -Infinity;
  for (const d of perDay) {
    for (const iv of [...d.available, ...d.booked]) {
      startMin = Math.min(startMin, iv.start);
      endMin = Math.max(endMin, iv.end);
    }
  }
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) {
    startMin = DEFAULT_START;
    endMin = DEFAULT_END;
  } else {
    startMin = floorToCell(startMin);
    endMin = ceilToCell(endMin);
  }

  const rowMins: number[] = [];
  for (let m = startMin; m < endMin; m += CELL_MIN) rowMins.push(m);

  const columns: DateColumn[] = perDay.map((d) => {
    const cells: Record<number, CellState> = {};
    for (const rowMin of rowMins) {
      if (overlapsCell(d.booked, rowMin)) cells[rowMin] = "booked";
      else if (overlapsCell(d.available, rowMin)) cells[rowMin] = "available";
      else cells[rowMin] = "off";
    }
    return { dayKey: d.dayKey, cells };
  });

  return { rowMins, columns, startMin, endMin };
}

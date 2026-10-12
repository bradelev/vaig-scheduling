/**
 * Pure builder for the weekly availability MAP (Phase 1C.2 follow-up): a
 * days × time-slots grid showing which half-hour cells a staff member has
 * ENABLED by their recurring 'weekly' rules. Read-only visualization — editing
 * stays in the rule lists. No I/O; unit-tested.
 *
 * Only 'weekly' rules feed the map (they repeat every week). 'open'/'block'
 * rules are tied to specific dates, not a weekday, so they can't be shown on a
 * generic week — they keep their own lists in the editor.
 */
import { union, type Interval } from "./intervals";

/** A weekly rule as the map needs it (weekday 0..6, minute range). */
export type WeeklyRule = { weekday: number; start_min: number; end_min: number };

/** Minutes-per-cell in the grid. 30 = half-hour rows. */
export const CELL_MIN = 30;

/** Default window when there are no rules yet (08:00–21:00 local). */
const DEFAULT_START = 8 * 60;
const DEFAULT_END = 21 * 60;

export type WeekMap = {
  /** Row start minutes, ascending (e.g. [480, 510, 540, …]). */
  rowMins: number[];
  /** Column weekdays in render order (Monday-first): [1,2,3,4,5,6,0]. */
  weekdays: number[];
  /**
   * covered[weekday][rowMin] === true when that half-hour cell is inside an
   * enabled weekly interval for that weekday. Keyed by weekday then row-start.
   */
  covered: Record<number, Record<number, boolean>>;
  /** The window actually shown, for labels. */
  startMin: number;
  endMin: number;
};

/** Monday-first weekday order (the data uses 0=Sunday..6=Saturday). */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Merged enabled intervals per weekday (0..6) from the weekly rules. */
function intervalsByWeekday(rules: WeeklyRule[]): Record<number, Interval[]> {
  const byDay: Record<number, Interval[]> = {};
  for (const r of rules) {
    const iv: Interval = { start: r.start_min, end: r.end_min };
    byDay[r.weekday] = union(byDay[r.weekday] ?? [], [iv]);
  }
  return byDay;
}

/** Round down/up to the CELL grid so the visible window aligns to rows. */
function floorToCell(min: number): number {
  return Math.floor(min / CELL_MIN) * CELL_MIN;
}
function ceilToCell(min: number): number {
  return Math.ceil(min / CELL_MIN) * CELL_MIN;
}

/**
 * Build the week map. The visible row window spans the earliest start to the
 * latest end across all rules (snapped to the cell grid), or the default
 * 08:00–21:00 when there are no rules. A cell is "covered" when a weekly
 * interval for that weekday OVERLAPS the cell [rowMin, rowMin+CELL) at all —
 * so a partial (e.g. 09:15) edge still paints its 30-min cell rather than
 * hiding real availability. The rule lists below always show the exact range.
 */
export function buildWeekMap(rules: WeeklyRule[]): WeekMap {
  const byDay = intervalsByWeekday(rules);

  let startMin = DEFAULT_START;
  let endMin = DEFAULT_END;
  if (rules.length > 0) {
    startMin = Math.min(...rules.map((r) => r.start_min));
    endMin = Math.max(...rules.map((r) => r.end_min));
    startMin = floorToCell(startMin);
    endMin = ceilToCell(endMin);
    // Guard against a degenerate window.
    if (endMin <= startMin) endMin = startMin + CELL_MIN;
  }

  const rowMins: number[] = [];
  for (let m = startMin; m < endMin; m += CELL_MIN) rowMins.push(m);

  const covered: Record<number, Record<number, boolean>> = {};
  for (const wd of WEEK_ORDER) {
    covered[wd] = {};
    const ivs = byDay[wd] ?? [];
    for (const rowMin of rowMins) {
      const cellEnd = rowMin + CELL_MIN;
      // Covered iff some interval OVERLAPS the cell at all (over-report over
      // hide): a partial edge like 09:15–09:30 still paints the 09:00 cell.
      covered[wd][rowMin] = ivs.some((iv) => iv.start < cellEnd && iv.end > rowMin);
    }
  }

  return { rowMins, weekdays: WEEK_ORDER, covered, startMin, endMin };
}

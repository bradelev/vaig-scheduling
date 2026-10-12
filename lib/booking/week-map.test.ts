// Invented data only. Minutes from midnight; 540=09:00, 780=13:00, 1200=20:00.
import { describe, expect, it } from "vitest";
import { buildWeekMap, WEEK_ORDER, CELL_MIN, type WeeklyRule } from "./week-map";

describe("buildWeekMap — window", () => {
  it("uses the default 08:00–21:00 window when there are no rules", () => {
    const map = buildWeekMap([]);
    expect(map.startMin).toBe(480); // 08:00
    expect(map.endMin).toBe(1260); // 21:00
    expect(map.rowMins[0]).toBe(480);
    expect(map.rowMins.at(-1)).toBe(1260 - CELL_MIN);
  });

  it("spans the earliest start to the latest end across rules, snapped to the grid", () => {
    const rules: WeeklyRule[] = [
      { weekday: 2, start_min: 555, end_min: 780 }, // 09:15–13:00
      { weekday: 4, start_min: 600, end_min: 1215 }, // 10:00–20:15
    ];
    const map = buildWeekMap(rules);
    expect(map.startMin).toBe(540); // 09:15 floored to 09:00
    expect(map.endMin).toBe(1230); // 20:15 ceiled to 20:30
  });

  it("renders Monday-first columns", () => {
    expect(buildWeekMap([]).weekdays).toEqual(WEEK_ORDER);
    expect(WEEK_ORDER).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });
});

describe("buildWeekMap — coverage", () => {
  it("marks cells inside a weekly interval as covered, others not", () => {
    // Tuesday 09:00–11:00 (540–660).
    const map = buildWeekMap([{ weekday: 2, start_min: 540, end_min: 660 }]);
    // Window is 09:00–11:00, rows at 540, 570, 600, 630 (11:00 is the exclusive end).
    expect(map.rowMins).toEqual([540, 570, 600, 630]);
    expect(map.covered[2][540]).toBe(true); // 09:00 cell
    expect(map.covered[2][600]).toBe(true); // 10:00 cell
    expect(map.covered[2][630]).toBe(true); // 10:30 cell (ends 11:00 = end)
    // A different day is empty for every row.
    expect(map.covered[3][540]).toBe(false);
  });

  it("a cell PARTIALLY covered IS marked (over-report, don't hide slivers)", () => {
    // 09:00–09:20 overlaps the 09:00–09:30 cell → covered (a 20-min sliver still
    // shows rather than being hidden by the 30-min granularity).
    const map = buildWeekMap([{ weekday: 1, start_min: 540, end_min: 560 }]);
    // window snaps to 09:00–09:30, one row at 540.
    expect(map.covered[1][540]).toBe(true);
  });

  it("paints ragged edges from odd-minute rules (09:15 start, 20:15 end)", () => {
    // 09:15–20:15 → window snaps to 09:00–20:30; the 09:00 cell (holds 09:15)
    // and the 20:00 cell (holds 20:15) must be painted, not hidden.
    const map = buildWeekMap([{ weekday: 2, start_min: 555, end_min: 1215 }]);
    expect(map.startMin).toBe(540); // 09:00
    expect(map.endMin).toBe(1230); // 20:30
    expect(map.covered[2][540]).toBe(true); // 09:00 cell holds the 09:15 start
    expect(map.covered[2][1200]).toBe(true); // 20:00 cell holds the 20:15 end
  });

  it("merges two ranges on the same day into one continuous coverage", () => {
    // 09:00–11:00 and 11:00–13:00 → covered 09:00–13:00 continuously.
    const map = buildWeekMap([
      { weekday: 3, start_min: 540, end_min: 660 },
      { weekday: 3, start_min: 660, end_min: 780 },
    ]);
    for (let m = 540; m < 780; m += CELL_MIN) {
      expect(map.covered[3][m]).toBe(true);
    }
  });

  it("leaves a gap between two non-touching ranges uncovered", () => {
    // 09:00–10:00 and 12:00–13:00 → 10:00–12:00 is a gap.
    const map = buildWeekMap([
      { weekday: 5, start_min: 540, end_min: 600 },
      { weekday: 5, start_min: 720, end_min: 780 },
    ]);
    expect(map.covered[5][540]).toBe(true); // 09:00
    expect(map.covered[5][600]).toBe(false); // 10:00 (gap)
    expect(map.covered[5][690]).toBe(false); // 11:30 (gap)
    expect(map.covered[5][720]).toBe(true); // 12:00
  });

  it("covers every weekday key even with no rule for it", () => {
    const map = buildWeekMap([{ weekday: 1, start_min: 540, end_min: 600 }]);
    for (const wd of WEEK_ORDER) {
      expect(map.covered[wd]).toBeDefined();
    }
  });
});

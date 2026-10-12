// Invented data only. Montevideo is fixed -03:00; 09:00 MVD = 12:00Z.
// Minutes from midnight: 540=09:00, 780=13:00, 900=15:00, 1200=20:00.
import { describe, expect, it } from "vitest";
import { buildDateMap, type DateMapInput } from "./date-map";
import type { HourRule, BusyInterval } from "./slots";

describe("buildDateMap — per-date availability", () => {
  // Two 'open' days like the External import: Mon 31/8 09:00–15:00, Tue 01/9 13:00–20:00.
  const rules: HourRule[] = [
    { kind: "open", on_date: "2026-08-31", start_min: 540, end_min: 900 },
    { kind: "open", on_date: "2026-09-01", start_min: 780, end_min: 1200 },
  ];

  it("paints available cells on the days that have rules, off elsewhere", () => {
    const map = buildDateMap({ fromDayKey: "2026-08-31", days: 2, rules, busy: [] });
    expect(map.columns.map((c) => c.dayKey)).toEqual(["2026-08-31", "2026-09-01"]);
    // Window spans 09:00 (earliest) to 20:00 (latest).
    expect(map.startMin).toBe(540);
    expect(map.endMin).toBe(1200);

    const day0 = map.columns[0].cells; // Mon 09:00–15:00
    expect(day0[540]).toBe("available"); // 09:00
    expect(day0[870]).toBe("available"); // 14:30 (last cell before 15:00)
    expect(day0[900]).toBe("off"); // 15:00 cell — availability ends at 15:00 (exclusive)
    expect(day0[780]).toBe("available"); // 13:00 still inside 09-15

    const day1 = map.columns[1].cells; // Tue 13:00–20:00
    expect(day1[540]).toBe("off"); // 09:00 — Tue starts at 13:00
    expect(day1[780]).toBe("available"); // 13:00
    expect(day1[1170]).toBe("available"); // 19:30 (last before 20:00)
  });

  it("marks a booked session's cells as 'booked' (beats available)", () => {
    // A session Mon 10:00–11:00 MVD = 13:00Z–14:00Z, attended by this person.
    const busy: BusyInterval[] = [
      { starts_at: "2026-08-31T13:00:00Z", ends_at: "2026-08-31T14:00:00Z" },
    ];
    const map = buildDateMap({ fromDayKey: "2026-08-31", days: 1, rules, busy });
    const day0 = map.columns[0].cells;
    expect(day0[540]).toBe("available"); // 09:00 free
    expect(day0[600]).toBe("booked"); // 10:00 booked
    expect(day0[630]).toBe("booked"); // 10:30 booked
    expect(day0[660]).toBe("available"); // 11:00 free again
  });

  it("subtracts a block from availability (block → off, not available)", () => {
    const withBlock: HourRule[] = [
      { kind: "open", on_date: "2026-08-31", start_min: 540, end_min: 900 },
      { kind: "block", on_date: "2026-08-31", start_min: 690, end_min: 720 }, // 11:30–12:00
    ];
    const map = buildDateMap({ fromDayKey: "2026-08-31", days: 1, rules: withBlock, busy: [] });
    const c = map.columns[0].cells;
    expect(c[660]).toBe("available"); // 11:00
    expect(c[690]).toBe("off"); // 11:30 blocked
    expect(c[720]).toBe("available"); // 12:00 open again
  });

  it("a weekly rule fills the matching weekday within the window", () => {
    // Weekly Tuesday (weekday=2) 13:00–20:00; window starts on a Monday.
    const weekly: HourRule[] = [
      { kind: "weekly", weekday: 2, start_min: 780, end_min: 1200 },
    ];
    // 2026-08-31 is Monday, 2026-09-01 is Tuesday.
    const map = buildDateMap({ fromDayKey: "2026-08-31", days: 2, rules: weekly, busy: [] });
    expect(map.columns[0].cells[780]).toBe("off"); // Monday, no weekly
    expect(map.columns[1].cells[780]).toBe("available"); // Tuesday 13:00
  });

  it("uses the default window and all-off when there's nothing", () => {
    const map = buildDateMap({ fromDayKey: "2026-08-31", days: 1, rules: [], busy: [] });
    expect(map.startMin).toBe(480); // 08:00
    expect(map.endMin).toBe(1200); // 20:00
    expect(Object.values(map.columns[0].cells).every((s) => s === "off")).toBe(true);
  });
});

describe("buildDateMap — window", () => {
  it("enumerates the requested number of consecutive days", () => {
    const input: DateMapInput = {
      fromDayKey: "2026-09-07",
      days: 7,
      rules: [],
      busy: [],
    };
    const map = buildDateMap(input);
    expect(map.columns.map((c) => c.dayKey)).toEqual([
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
    ]);
  });
});

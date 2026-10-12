// Invented data only. Montevideo is a fixed -03:00 (no DST), so a local wall
// clock HH:MM on day D is the instant `${D}T${HH:MM}:00-03:00`, i.e. HH:MM+03 UTC.
// e.g. 09:00 MVD on 2026-09-01 = 2026-09-01T12:00:00Z.
import { describe, expect, it } from "vitest";
import {
  localDayKey,
  localWeekday,
  localMinuteToInstant,
  busyToLocalInterval,
  availabilityForDay,
  blocksForDay,
  computeDaySlots,
  type HourRule,
} from "./slots";

describe("localDayKey / localWeekday", () => {
  it("maps an instant to its Montevideo calendar day", () => {
    // 2026-09-02T01:00:00Z = 2026-09-01 22:00 MVD → still Sept 1 locally.
    expect(localDayKey(new Date("2026-09-02T01:00:00Z").getTime())).toBe(
      "2026-09-01",
    );
  });

  it("weekday is 0=Sunday..6=Saturday", () => {
    expect(localWeekday("2026-08-30")).toBe(0); // Sunday
    expect(localWeekday("2026-08-31")).toBe(1); // Monday
    expect(localWeekday("2026-09-04")).toBe(5); // Friday
    expect(localWeekday("2026-08-29")).toBe(6); // Saturday
  });
});

describe("localMinuteToInstant", () => {
  it("540 minutes (09:00) on 2026-09-01 → 12:00Z", () => {
    expect(localMinuteToInstant("2026-09-01", 540)).toBe(
      "2026-09-01T12:00:00.000Z",
    );
  });
  it("pads hours and minutes", () => {
    // 8:05 = 485 → 11:05Z
    expect(localMinuteToInstant("2026-09-01", 485)).toBe(
      "2026-09-01T11:05:00.000Z",
    );
  });
});

describe("busyToLocalInterval", () => {
  it("projects a same-day session to local minutes", () => {
    // 10:00-11:00 MVD = 13:00Z-14:00Z → [600, 660).
    expect(
      busyToLocalInterval(
        { starts_at: "2026-09-01T13:00:00Z", ends_at: "2026-09-01T14:00:00Z" },
        "2026-09-01",
      ),
    ).toEqual({ start: 600, end: 660 });
  });

  it("clips a session that spills past local midnight", () => {
    // 23:00 MVD (02:00Z next day) to 00:30 MVD next day (03:30Z) → on 09-01,
    // busy from 23:00 (1380) to midnight (1440).
    expect(
      busyToLocalInterval(
        { starts_at: "2026-09-02T02:00:00Z", ends_at: "2026-09-02T03:30:00Z" },
        "2026-09-01",
      ),
    ).toEqual({ start: 1380, end: 1440 });
  });

  it("returns null for a session on another day", () => {
    expect(
      busyToLocalInterval(
        { starts_at: "2026-09-05T13:00:00Z", ends_at: "2026-09-05T14:00:00Z" },
        "2026-09-01",
      ),
    ).toBeNull();
  });

  it("a NULL ends_at is treated as a 60-min booking, not free time", () => {
    // starts 10:00 MVD (13:00Z), no end → busy [600, 660) (10:00-11:00).
    // Never null: that would double-book the slot it occupies.
    expect(
      busyToLocalInterval({ starts_at: "2026-09-01T13:00:00Z", ends_at: null }, "2026-09-01"),
    ).toEqual({ start: 600, end: 660 });
  });
});

describe("availabilityForDay", () => {
  // 2026-08-31 is Monday (weekday 1); 2026-09-01 is Tuesday (weekday 2).
  const rules: HourRule[] = [
    { kind: "weekly", weekday: 1, start_min: 540, end_min: 780 }, // Mon 9-13
    { kind: "open", on_date: "2026-08-31", start_min: 720, end_min: 900 }, // extra 12-15 that Mon
    { kind: "open", on_date: "2026-09-05", start_min: 600, end_min: 660 }, // different day
    { kind: "block", on_date: "2026-08-31", start_min: 690, end_min: 720 }, // ignored here
  ];

  it("unions weekly (for the weekday) with open (for the date)", () => {
    // 2026-08-31 is Monday → weekly 9-13 ∪ open 12-15 = 9-15 (540-900).
    expect(availabilityForDay("2026-08-31", rules)).toEqual([
      { start: 540, end: 900 },
    ]);
  });

  it("ignores weekly rules for other weekdays and open rules for other dates", () => {
    // 2026-09-01 is Tuesday: no weekly weekday=2, no open for that date → empty.
    expect(availabilityForDay("2026-09-01", rules)).toEqual([]);
  });
});

describe("blocksForDay", () => {
  it("returns a partial block range", () => {
    const rules: HourRule[] = [
      { kind: "block", on_date: "2026-09-01", start_min: 690, end_min: 720 },
    ];
    expect(blocksForDay("2026-09-01", rules)).toEqual([{ start: 690, end: 720 }]);
  });

  it("an all-day block (null range) covers the whole day", () => {
    const rules: HourRule[] = [
      { kind: "block", on_date: "2026-09-01", start_min: null, end_min: null },
    ];
    expect(blocksForDay("2026-09-01", rules)).toEqual([{ start: 0, end: 1440 }]);
  });
});

describe("computeDaySlots", () => {
  // Monday 2026-08-31: Lu's real-ish shape from the load — open 9-15 with a
  // 11:30-12:00 block. (Times as local MVD.)
  const luMonday: HourRule[] = [
    { kind: "open", on_date: "2026-08-31", start_min: 540, end_min: 900 }, // 9-15
    { kind: "block", on_date: "2026-08-31", start_min: 690, end_min: 720 }, // 11:30-12:00
  ];

  it("produces 60-min slots on a 60-min grid, minus the block", () => {
    const slots = computeDaySlots({
      dayKey: "2026-08-31",
      rules: luMonday,
      busy: [],
      durationMin: 60,
      stepMin: 60,
    });
    // Free = 9-11:30 and 12-15. 60-min starts on the hour that fit:
    //   9:00,10:00 (10:30 would end 11:30 = ok but 10:00 grid → next is 11:00
    //   which ends 12:00 > 11:30, excluded) ... let's list: 9,10 in first gap
    //   (11:00 ends 12:00 >11:30 → out). Second gap 12-15: 12,13,14.
    const local = slots.map((s) => localTime(s.startsAt));
    expect(local).toEqual(["09:00", "10:00", "12:00", "13:00", "14:00"]);
  });

  it("subtracts an already-booked session", () => {
    // Book 13:00-14:00 MVD (16:00Z-17:00Z). 13:00 slot disappears.
    const slots = computeDaySlots({
      dayKey: "2026-08-31",
      rules: luMonday,
      busy: [{ starts_at: "2026-08-31T16:00:00Z", ends_at: "2026-08-31T17:00:00Z" }],
      durationMin: 60,
      stepMin: 60,
    });
    expect(slots.map((s) => localTime(s.startsAt))).toEqual([
      "09:00",
      "10:00",
      "12:00",
      "14:00",
    ]);
  });

  it("a booked session with NULL ends_at still blocks its slot (no double-book)", () => {
    // The P1 regression: a synced session 13:00 MVD (16:00Z) with ends_at=null
    // must remove the 13:00 slot (busy 13:00-14:00 via the 60-min fallback).
    const slots = computeDaySlots({
      dayKey: "2026-08-31",
      rules: luMonday,
      busy: [{ starts_at: "2026-08-31T16:00:00Z", ends_at: null }],
      durationMin: 60,
      stepMin: 60,
    });
    expect(slots.map((s) => localTime(s.startsAt))).toEqual([
      "09:00",
      "10:00",
      "12:00",
      "14:00",
    ]);
  });

  it("drops slots at or before now", () => {
    // now = 2026-08-31 12:30 MVD (15:30Z). Only 13:00 and 14:00 remain from the
    // afternoon gap; morning is past.
    const slots = computeDaySlots({
      dayKey: "2026-08-31",
      rules: luMonday,
      busy: [],
      durationMin: 60,
      stepMin: 60,
      nowMs: new Date("2026-08-31T15:30:00Z").getTime(),
    });
    expect(slots.map((s) => localTime(s.startsAt))).toEqual(["13:00", "14:00"]);
  });

  it("returns nothing when the whole day is blocked", () => {
    const slots = computeDaySlots({
      dayKey: "2026-08-31",
      rules: [
        { kind: "open", on_date: "2026-08-31", start_min: 540, end_min: 900 },
        { kind: "block", on_date: "2026-08-31", start_min: null, end_min: null },
      ],
      busy: [],
      durationMin: 60,
      stepMin: 60,
    });
    expect(slots).toEqual([]);
  });

  it("returns nothing on a day with no availability", () => {
    expect(
      computeDaySlots({
        dayKey: "2026-09-02",
        rules: luMonday,
        busy: [],
        durationMin: 60,
        stepMin: 60,
      }),
    ).toEqual([]);
  });

  it("a longer service yields fewer starts (duration awareness)", () => {
    // 90-min service, 30-min grid, in the clean 12-15 gap: 12:00,12:30,13:00,
    // 13:30 (ends 15:00). First gap 9-11:30 fits 90 at 9:00,9:30,10:00 (10:00
    // ends 11:30). 10:30 ends 12:00 > 11:30 → out.
    const slots = computeDaySlots({
      dayKey: "2026-08-31",
      rules: luMonday,
      busy: [],
      durationMin: 90,
      stepMin: 30,
    });
    expect(slots.map((s) => localTime(s.startsAt))).toEqual([
      "09:00",
      "09:30",
      "10:00",
      "12:00",
      "12:30",
      "13:00",
      "13:30",
    ]);
  });
});

// Helper: render an ISO instant as its Montevideo HH:MM for readable assertions.
function localTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour").padStart(2, "0")}:${get("minute").padStart(2, "0")}`;
}

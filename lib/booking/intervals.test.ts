// Invented data only. Minutes-from-midnight; e.g. 540 = 09:00, 600 = 10:00.
import { describe, expect, it } from "vitest";
import { normalize, union, subtract, slotStarts, type Interval } from "./intervals";

const iv = (start: number, end: number): Interval => ({ start, end });

describe("normalize", () => {
  it("sorts and drops empty/inverted intervals", () => {
    expect(normalize([iv(600, 660), iv(540, 600), iv(700, 700), iv(800, 750)]))
      .toEqual([iv(540, 660)]); // 540-600 touches 600-660 → merged; empties gone
  });

  it("merges overlapping intervals", () => {
    expect(normalize([iv(540, 620), iv(600, 700)])).toEqual([iv(540, 700)]);
  });

  it("merges touching intervals (end === next.start)", () => {
    // 9-10 then 10-11 is a continuous 9-11 for availability purposes.
    expect(normalize([iv(540, 600), iv(600, 660)])).toEqual([iv(540, 660)]);
  });

  it("keeps a gap between non-touching intervals", () => {
    expect(normalize([iv(540, 600), iv(660, 720)])).toEqual([
      iv(540, 600),
      iv(660, 720),
    ]);
  });

  it("does not mutate its input", () => {
    const input = [iv(600, 660), iv(540, 600)];
    const snapshot = JSON.parse(JSON.stringify(input));
    normalize(input);
    expect(input).toEqual(snapshot);
  });
});

describe("union", () => {
  it("merges availability from two rule sources (weekly ∪ open)", () => {
    // weekly 9-13, open extra 12-15 → 9-15.
    expect(union([iv(540, 780)], [iv(720, 900)])).toEqual([iv(540, 900)]);
  });
  it("keeps disjoint openings separate", () => {
    expect(union([iv(540, 660)], [iv(780, 900)])).toEqual([
      iv(540, 660),
      iv(780, 900),
    ]);
  });
});

describe("subtract", () => {
  it("punches a block out of the middle", () => {
    // 9-15 minus a 11:30-12:00 block → 9-11:30 and 12:00-15.
    expect(subtract([iv(540, 900)], [iv(690, 720)])).toEqual([
      iv(540, 690),
      iv(720, 900),
    ]);
  });

  it("removes a hole at the start edge", () => {
    expect(subtract([iv(540, 900)], [iv(540, 600)])).toEqual([iv(600, 900)]);
  });

  it("removes a hole at the end edge", () => {
    expect(subtract([iv(540, 900)], [iv(840, 900)])).toEqual([iv(540, 840)]);
  });

  it("a full-day block removes everything", () => {
    expect(subtract([iv(540, 900)], [iv(0, 1440)])).toEqual([]);
  });

  it("subtracts multiple holes (block + two booked sessions)", () => {
    // 9-20 (540-1200) minus block 13-13:30, session 10-11, session 15-16.
    expect(
      subtract([iv(540, 1200)], [iv(780, 810), iv(600, 660), iv(900, 960)]),
    ).toEqual([iv(540, 600), iv(660, 780), iv(810, 900), iv(960, 1200)]);
  });

  it("ignores holes that don't overlap", () => {
    expect(subtract([iv(540, 660)], [iv(700, 800)])).toEqual([iv(540, 660)]);
  });

  it("handles adjacent (touching) holes without leaving a zero gap", () => {
    // Two back-to-back sessions 10-11 and 11-12 out of 9-13.
    expect(subtract([iv(540, 780)], [iv(600, 660), iv(660, 720)])).toEqual([
      iv(540, 600),
      iv(720, 780),
    ]);
  });

  it("subtracts across several base segments", () => {
    // Two openings 9-11 and 14-16; a session 10-10:30 hits only the first.
    expect(subtract([iv(540, 660), iv(840, 960)], [iv(600, 630)])).toEqual([
      iv(540, 600),
      iv(630, 660),
      iv(840, 960),
    ]);
  });
});

describe("slotStarts", () => {
  it("offers grid starts that fully fit the duration", () => {
    // 9-11 (540-660), 60-min service, 30-min grid → 9:00, 9:30, 10:00.
    // 10:30 would end 11:30 > 11:00, so it's excluded.
    expect(slotStarts([iv(540, 660)], 60, 30)).toEqual([540, 570, 600]);
  });

  it("the last start ends exactly at the boundary (inclusive fit)", () => {
    // 9-10 (540-600), 30-min service, 30 grid → 9:00 and 9:30 (ends 10:00 = end).
    expect(slotStarts([iv(540, 600)], 30, 30)).toEqual([540, 570]);
  });

  it("returns nothing when the free window is shorter than the service", () => {
    // 9-9:30 opening, 60-min service → doesn't fit.
    expect(slotStarts([iv(540, 570)], 60, 30)).toEqual([]);
  });

  it("respects the step grid (60-min grid skips half-hours)", () => {
    expect(slotStarts([iv(540, 720)], 60, 60)).toEqual([540, 600, 660]);
  });

  it("collects starts across multiple free intervals, ascending", () => {
    expect(slotStarts([iv(840, 900), iv(540, 600)], 30, 30)).toEqual([
      540, 570, 840, 870,
    ]);
  });

  it("guards against non-positive duration/step", () => {
    expect(slotStarts([iv(540, 660)], 0, 30)).toEqual([]);
    expect(slotStarts([iv(540, 660)], 60, 0)).toEqual([]);
  });
});

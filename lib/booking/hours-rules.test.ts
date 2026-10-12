// Invented data only. Minutes-from-midnight; 540=09:00, 780=13:00, 1200=20:00.
import { describe, expect, it } from "vitest";
import { validateRule, timeToMin, minToTime } from "./hours-rules";

describe("validateRule — weekly", () => {
  it("accepts a valid weekly rule", () => {
    const r = validateRule({ kind: "weekly", weekday: 2, startMin: 780, endMin: 1200 });
    expect(r).toEqual({
      ok: true,
      row: { kind: "weekly", weekday: 2, on_date: null, start_min: 780, end_min: 1200 },
    });
  });

  it("rejects a missing/invalid weekday", () => {
    expect(validateRule({ kind: "weekly", startMin: 540, endMin: 600 }).ok).toBe(false);
    expect(validateRule({ kind: "weekly", weekday: 7, startMin: 540, endMin: 600 }).ok).toBe(false);
  });

  it("rejects end <= start", () => {
    expect(validateRule({ kind: "weekly", weekday: 1, startMin: 600, endMin: 600 }).ok).toBe(false);
    expect(validateRule({ kind: "weekly", weekday: 1, startMin: 700, endMin: 600 }).ok).toBe(false);
  });

  it("rejects a range outside 0..1440", () => {
    expect(validateRule({ kind: "weekly", weekday: 1, startMin: -1, endMin: 600 }).ok).toBe(false);
    expect(validateRule({ kind: "weekly", weekday: 1, startMin: 600, endMin: 1441 }).ok).toBe(false);
  });
});

describe("validateRule — open", () => {
  it("accepts a valid one-off open day", () => {
    const r = validateRule({ kind: "open", onDate: "2026-09-20", startMin: 540, endMin: 780 });
    expect(r).toEqual({
      ok: true,
      row: { kind: "open", weekday: null, on_date: "2026-09-20", start_min: 540, end_min: 780 },
    });
  });

  it("rejects a missing/malformed date", () => {
    expect(validateRule({ kind: "open", startMin: 540, endMin: 780 }).ok).toBe(false);
    expect(validateRule({ kind: "open", onDate: "20/09/2026", startMin: 540, endMin: 780 }).ok).toBe(false);
  });

  it("rejects a bad range", () => {
    expect(validateRule({ kind: "open", onDate: "2026-09-20", startMin: 780, endMin: 540 }).ok).toBe(false);
  });
});

describe("validateRule — block", () => {
  it("accepts a partial-day block (with a range)", () => {
    const r = validateRule({ kind: "block", onDate: "2026-09-20", startMin: 690, endMin: 720 });
    expect(r).toEqual({
      ok: true,
      row: { kind: "block", weekday: null, on_date: "2026-09-20", start_min: 690, end_min: 720 },
    });
  });

  it("accepts an all-day block (no range)", () => {
    const r = validateRule({ kind: "block", onDate: "2026-09-20" });
    expect(r).toEqual({
      ok: true,
      row: { kind: "block", weekday: null, on_date: "2026-09-20", start_min: null, end_min: null },
    });
  });

  it("rejects a half-specified range (only start)", () => {
    expect(validateRule({ kind: "block", onDate: "2026-09-20", startMin: 690 }).ok).toBe(false);
  });

  it("rejects a bad range but not the all-day case", () => {
    expect(validateRule({ kind: "block", onDate: "2026-09-20", startMin: 720, endMin: 690 }).ok).toBe(false);
  });

  it("rejects a missing date", () => {
    expect(validateRule({ kind: "block" }).ok).toBe(false);
  });
});

describe("timeToMin / minToTime", () => {
  it("parses HH:MM to minutes", () => {
    expect(timeToMin("09:00")).toBe(540);
    expect(timeToMin("13:30")).toBe(810);
    expect(timeToMin("00:00")).toBe(0);
    expect(timeToMin("23:59")).toBe(1439);
  });
  it("rejects malformed / out-of-range times", () => {
    expect(timeToMin("9:00")).toBeNull();
    expect(timeToMin("24:00")).toBeNull();
    expect(timeToMin("12:60")).toBeNull();
    expect(timeToMin("")).toBeNull();
  });
  it("round-trips", () => {
    expect(minToTime(540)).toBe("09:00");
    expect(minToTime(810)).toBe("13:30");
    expect(minToTime(0)).toBe("00:00");
  });
});

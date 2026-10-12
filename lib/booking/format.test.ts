// Invented data only. slotToLocalInput must yield MONTEVIDEO wall-clock (fixed
// -03:00) regardless of the machine timezone — that's the whole point of the P1
// fix: the picked-slot instant and its shown time must agree on any device.
import { describe, expect, it } from "vitest";
import { slotToLocalInput, slotTimeLabel, slotDayLabel } from "./format";

describe("slotToLocalInput", () => {
  it("renders a slot instant as Montevideo wall-clock for datetime-local", () => {
    // 2026-09-03T13:00:00Z = 10:00 MVD (−03:00).
    expect(slotToLocalInput("2026-09-03T13:00:00Z")).toBe("2026-09-03T10:00");
  });

  it("handles a time near local midnight without rolling the date", () => {
    // 2026-09-04T02:30:00Z = 2026-09-03 23:30 MVD.
    expect(slotToLocalInput("2026-09-04T02:30:00Z")).toBe("2026-09-03T23:30");
  });

  it("pads single-digit hours/minutes", () => {
    // 2026-09-03T12:05:00Z = 09:05 MVD.
    expect(slotToLocalInput("2026-09-03T12:05:00Z")).toBe("2026-09-03T09:05");
  });

  it("is the inverse of the -03:00 instant template (round-trips)", () => {
    // The engine builds instants as `${day}T${HH:MM}:00-03:00`; this must read
    // them back to the same wall-clock string the field shows.
    const instant = new Date("2026-09-03T15:30:00-03:00").toISOString();
    expect(slotToLocalInput(instant)).toBe("2026-09-03T15:30");
  });
});

describe("slotTimeLabel", () => {
  it("shows Montevideo HH:mm", () => {
    expect(slotTimeLabel("2026-09-03T13:00:00Z")).toBe("10:00");
    expect(slotTimeLabel("2026-09-03T12:05:00Z")).toBe("09:05");
  });
});

describe("slotDayLabel", () => {
  it("shows Spanish weekday + dd/mm", () => {
    // 2026-09-03 is a Thursday. es-UY 'short' weekday is like "jue".
    const label = slotDayLabel("2026-09-03");
    expect(label).toMatch(/^jue\.? 03\/09$/); // ICU may or may not add a dot
  });
});

import { describe, expect, it } from "vitest";
import { needsImmediateReminder } from "./immediate-reminder";

// The Node twin of send-reminders/logic.ts's needsImmediateReminder. These
// mirror the Deno unit tests exactly so the two implementations can't drift on
// the boundary cases. All instants America/Montevideo (UTC-3, no DST).
describe("needsImmediateReminder (Node twin, #120)", () => {
  it("tomorrow session created AFTER 16:00 today → true", () => {
    // now = 2026-07-15 17:00 MVD (20:00Z); session = 2026-07-16 10:00 MVD.
    expect(
      needsImmediateReminder("2026-07-16T13:00:00Z", new Date("2026-07-15T20:00:00Z")),
    ).toBe(true);
  });

  it("tomorrow session created BEFORE 16:00 today → false (batch covers it)", () => {
    expect(
      needsImmediateReminder("2026-07-16T13:00:00Z", new Date("2026-07-15T13:00:00Z")),
    ).toBe(false);
  });

  it("exactly 16:00 MVD counts as after → true", () => {
    expect(
      needsImmediateReminder("2026-07-16T13:00:00Z", new Date("2026-07-15T19:00:00Z")),
    ).toBe(true);
  });

  it("session 2+ days out → false", () => {
    expect(
      needsImmediateReminder("2026-07-17T13:00:00Z", new Date("2026-07-15T20:00:00Z")),
    ).toBe(false);
  });

  it("same-day session → false", () => {
    expect(
      needsImmediateReminder("2026-07-15T23:00:00Z", new Date("2026-07-15T20:00:00Z")),
    ).toBe(false);
  });

  it("day-boundary: a 23:30-local-tomorrow session still counts as tomorrow → true", () => {
    // session = 2026-07-16 23:30 MVD = 2026-07-17 02:30Z; must key to the 16th.
    expect(
      needsImmediateReminder("2026-07-17T02:30:00Z", new Date("2026-07-15T21:00:00Z")),
    ).toBe(true);
  });
});

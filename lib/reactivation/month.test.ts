import { describe, expect, it } from "vitest";
import { monthLabel } from "./month";

// Reference "now": 2026-08-08, Montevideo (UTC-3, no DST).
const NOW = new Date("2026-08-08T12:00:00-03:00");

describe("monthLabel", () => {
  it("returns the bare Spanish month within the last 12 months", () => {
    expect(monthLabel("2026-03-10T15:00:00-03:00", NOW)).toBe("marzo");
    expect(monthLabel("2026-07-31T20:00:00-03:00", NOW)).toBe("julio");
  });

  it("appends the year once the session is 12+ months old", () => {
    // Exactly 12 months back (Aug 2025) → ambiguous, so include the year.
    expect(monthLabel("2025-08-05T15:00:00-03:00", NOW)).toBe("agosto de 2025");
    expect(monthLabel("2024-12-20T15:00:00-03:00", NOW)).toBe(
      "diciembre de 2024",
    );
  });

  it("resolves the month in Montevideo time, not UTC", () => {
    // 2026-04-01T01:00Z is still 2026-03-31 22:00 in Montevideo → March.
    expect(monthLabel("2026-04-01T01:00:00Z", NOW)).toBe("marzo");
  });
});

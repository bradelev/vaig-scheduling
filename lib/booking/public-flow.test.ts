// Invented data only.
import { describe, expect, it } from "vitest";
import {
  addDays,
  dayChip,
  dayKeyOf,
  formatDuration,
  formatPhoneInput,
  formatPrice,
  groupCatalog,
  initialOf,
  mondayOf,
  nextScanMonday,
  summaryWhen,
  timeLabel,
  weekDays,
  weekLabel,
  type CatalogItem,
} from "./public-flow";

const item = (id: string, name: string, category: string): CatalogItem => ({
  id,
  name,
  category,
  durationMin: 30,
  priceUyu: 1850,
  depositUyu: 500,
  packageSessions: null,
});

describe("groupCatalog", () => {
  it("groups by category keeping item order; lead categories first, then first-appearance", () => {
    const g = groupCatalog([
      item("d", "Ritual", "Day Spa"),
      item("a", "Axilas", "Depilación Láser"),
      item("b", "Relax", "Masaje Estético"),
      item("c", "Pierna entera", "Depilación Láser"),
      item("e", "6 sesiones", "Cuponeras de Depilación Láser"),
    ]);
    expect(g.map((x) => [x.category, x.items.map((i) => i.name)])).toEqual([
      ["Depilación Láser", ["Axilas", "Pierna entera"]],
      ["Cuponeras de Depilación Láser", ["6 sesiones"]],
      ["Day Spa", ["Ritual"]],
      ["Masaje Estético", ["Relax"]],
    ]);
  });
});

describe("labels", () => {
  it("formats prices with a dot for thousands and no decimals", () => {
    expect(formatPrice(1850)).toBe("$1.850");
    expect(formatPrice(880)).toBe("$880");
    expect(formatPrice(null)).toBeNull();
  });
  it("formats durations", () => {
    expect(formatDuration(30)).toBe("30 min");
    expect(formatDuration(60)).toBe("1 h");
    expect(formatDuration(90)).toBe("1 h 30");
  });
  it("time and summary are Montevideo wall-clock", () => {
    expect(timeLabel("2026-09-04T17:30:00.000Z")).toBe("14:30");
    // 2026-09-03 is a Thursday.
    expect(summaryWhen("2026-09-03T17:30:00.000Z")).toBe("jue 3/9 · 14:30");
    // Day boundary in Montevideo: 01:30Z on the 8th is still the 7th (Monday).
    expect(summaryWhen("2026-09-08T01:30:00.000Z")).toBe("lun 7/9 · 22:30");
  });
  it("initials", () => {
    expect(initialOf("iara")).toBe("I");
    expect(initialOf("  ")).toBe("?");
  });
});

describe("week strip", () => {
  it("dayKeyOf uses the Montevideo day", () => {
    expect(dayKeyOf("2026-09-08T01:30:00.000Z")).toBe("2026-09-07");
  });
  it("mondayOf / weekDays / addDays", () => {
    expect(mondayOf("2026-09-04")).toBe("2026-08-31"); // Friday → Monday
    expect(mondayOf("2026-09-06")).toBe("2026-08-31"); // Sunday → same Monday
    expect(weekDays("2026-08-31")).toEqual([
      "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06",
    ]);
    expect(addDays("2026-08-31", 7)).toBe("2026-09-07");
  });
  it("weekLabel shows the month once when the week doesn't cross months", () => {
    expect(weekLabel("2026-09-07")).toBe("7 – 13 sep");
    expect(weekLabel("2026-08-31")).toBe("31 ago – 6 sep");
  });
  it("dayChip", () => {
    expect(dayChip("2026-09-03")).toEqual({ wd: "Jue", dd: "3" });
    expect(dayChip("2026-09-06")).toEqual({ wd: "Dom", dd: "6" });
  });
  it("nextScanMonday steps a week and stops past the 60-day horizon", () => {
    const today = "2026-08-31"; // a Monday
    expect(nextScanMonday("2026-08-31", today)).toBe("2026-09-07");
    // Horizon = 2026-10-30 (Friday). The week of Oct 26 starts within it…
    expect(nextScanMonday("2026-10-19", today)).toBe("2026-10-26");
    // …but the next Monday (Nov 2) is past it: the scan stops.
    expect(nextScanMonday("2026-10-26", today)).toBeNull();
    // Equality edge: from a Thursday, today+60 IS a Monday — still allowed.
    expect(nextScanMonday("2026-10-26", "2026-09-03")).toBe("2026-11-02");
  });
});

describe("formatPhoneInput", () => {
  it("groups a Uruguayan mobile as 099 123 456 while typing", () => {
    expect(formatPhoneInput("099")).toBe("099");
    expect(formatPhoneInput("0991")).toBe("099 1");
    expect(formatPhoneInput("099123456")).toBe("099 123 456");
    expect(formatPhoneInput("099-123-456")).toBe("099 123 456");
  });
  it("leaves international numbers as digits with the plus", () => {
    expect(formatPhoneInput("+598 99 123 456")).toBe("+59899123456");
  });
});

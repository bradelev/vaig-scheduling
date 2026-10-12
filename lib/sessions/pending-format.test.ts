// Invented data only.
import { describe, expect, it } from "vitest";
import {
  dayKeyOf,
  dayLabel,
  groupPendingByDay,
  timeRangeLabel,
  type PendingReservation,
} from "./pending-format";

const item = (id: string, startsAt: string): PendingReservation => ({
  id,
  startsAt,
  endsAt: null,
  clientName: "Ana Prueba",
  clientPhone: "+59891234567",
  serviceName: "Pierna entera",
  staffId: "lu",
  createdAt: startsAt,
  stale: false,
  pkg: null,
});

describe("dayKeyOf / timeRangeLabel — Montevideo wall-clock", () => {
  it("uses the Montevideo day, not UTC", () => {
    expect(dayKeyOf("2026-09-08T01:30:00.000Z")).toBe("2026-09-07"); // 22:30 local
  });
  it("labels a range in 24h and a lone start when the end is unknown", () => {
    expect(timeRangeLabel("2026-09-07T17:00:00.000Z", "2026-09-07T18:00:00.000Z")).toBe("14:00–15:00");
    expect(timeRangeLabel("2026-09-07T12:05:00.000Z", null)).toBe("09:05");
  });
});

describe("dayLabel", () => {
  it("marks today and tomorrow, plain weekday otherwise", () => {
    expect(dayLabel("2026-09-07", "2026-09-07")).toBe("Hoy · lunes 7/9");
    expect(dayLabel("2026-09-08", "2026-09-07")).toBe("Mañana · martes 8/9");
    expect(dayLabel("2026-09-09", "2026-09-07")).toBe("miércoles 9/9");
  });
});

describe("groupPendingByDay", () => {
  it("groups consecutive same-day items and labels relative to now", () => {
    const now = Date.parse("2026-09-07T13:00:00.000Z"); // Monday 10:00 local
    const groups = groupPendingByDay(
      [
        item("a", "2026-09-07T17:00:00.000Z"),
        item("b", "2026-09-07T19:00:00.000Z"),
        item("c", "2026-09-08T13:00:00.000Z"),
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Hoy · lunes 7/9", ["a", "b"]],
      ["Mañana · martes 8/9", ["c"]],
    ]);
  });
  it("empty in → empty out", () => {
    expect(groupPendingByDay([], Date.now())).toEqual([]);
  });
});

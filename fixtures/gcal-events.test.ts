/**
 * Invariants for the calendar fixtures (issue E2-T2): every §7.0 class is
 * present, all personal data is invented-but-valid, and the file keeps the
 * Google Calendar API shape the sync (E2-T3) will parse.
 */
import { describe, expect, it } from "vitest";
import {
  EMPLOYEES,
  NON_SESSION_PATTERNS,
  normalizePhone,
  normalizeText,
} from "../lib/normalize";
import fixture from "./gcal-events.json";

type FixtureEvent = (typeof fixture.items)[number] & {
  description?: string;
  colorId?: string;
};
const events = fixture.items as FixtureEvent[];

const employeeNo = new RegExp(`^(${EMPLOYEES.join("|")})\\s+no\\b`, "i");

describe("gcal-events fixture (PRD §7.0 coverage)", () => {
  it("has 20-30 events (issue #12 AC)", () => {
    expect(events.length).toBeGreaterThanOrEqual(20);
    expect(events.length).toBeLessThanOrEqual(30);
  });

  it("covers every §7.0 class", () => {
    const allDay = events.filter((e) => "date" in e.start);
    const external = events.filter((e) => e.summary.startsWith("External - "));
    const availability = events.filter((e) =>
      employeeNo.test(normalizeText(e.summary)),
    );
    const chores = events.filter((e) =>
      NON_SESSION_PATTERNS.some((p) => p.test(normalizeText(e.summary))),
    );
    const cancelled = events.filter((e) => e.status === "cancelled");

    expect(allDay.length).toBeGreaterThanOrEqual(1);
    expect(external.length).toBeGreaterThanOrEqual(4);
    expect(availability.length).toBeGreaterThanOrEqual(3);
    expect(chores.length).toBeGreaterThanOrEqual(4);
    expect(cancelled.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the External+manual duplicate pair (§7.0 dedup case)", () => {
    const external = events.find((e) => e.id.endsWith("ko06"))!;
    const manual = events.find((e) => e.id.endsWith("ma01"))!;
    expect(external.summary).toContain("Paula Silveira");
    expect(manual.summary).toContain("Paula Silveira");
    // Same slot, different duration — the artifact the dedup rule exists for.
    expect((external.start as { dateTime: string }).dateTime).toBe(
      (manual.start as { dateTime: string }).dateTime,
    );
    expect((external.end as { dateTime: string }).dateTime).not.toBe(
      (manual.end as { dateTime: string }).dateTime,
    );
  });

  it("every 8+ digit phone in a title normalizes to a valid +598 number", () => {
    for (const e of events) {
      for (const run of e.summary.match(/\d{8,}/g) ?? []) {
        expect(normalizePhone(run), `in "${e.summary}"`).toMatch(/^\+598/);
      }
    }
  });

  it("contains one deliberately invalid phone (goes to the report, never stored)", () => {
    const invalid = events.find((e) => e.id.endsWith("ma11"))!;
    const digits = invalid.summary.match(/\d+/g)!.join("");
    expect(normalizePhone(digits)).toBeNull();
  });

  it("uses only invented emails and fixture ids", () => {
    for (const e of events) {
      expect(e.creator.email).toMatch(/@example\.com$/);
      expect(e.organizer.email).toMatch(/@example\.com$/);
      expect(e.id).toMatch(/^vaigfx[a-z0-9]{20}$/);
    }
  });

  it("keeps the raw API shape the sync will parse", () => {
    for (const e of events) {
      expect(e.kind).toBe("calendar#event");
      expect(["confirmed", "cancelled"]).toContain(e.status);
      const start = e.start as { dateTime?: string; date?: string };
      expect(Boolean(start.dateTime) || Boolean(start.date)).toBe(true);
      if (start.dateTime) {
        expect(start.dateTime).toMatch(/-03:00$/);
        expect((e.start as { timeZone?: string }).timeZone).toBe(
          "America/Montevideo",
        );
      }
    }
  });
});

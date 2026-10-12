import { describe, expect, it } from "vitest";
import {
  joinedClientName,
  externalCoveredKeys,
  type ReminderCheckSession,
  type RemindedSession,
  missedReminders,
  reminderMetrics,
  RESPONSE_TARGET,
} from "./metrics";

describe("joinedClientName", () => {
  it("reads the name from a runtime OBJECT join (the real shape)", () => {
    // Regression: PostgREST returns a to-one join as an object; the old
    // `clients[0]` array access returned undefined → "(sin nombre)" for all.
    expect(joinedClientName({ full_name: "Ana Pérez" })).toBe("Ana Pérez");
  });

  it("reads the name from an ARRAY join (the generic-typed shape)", () => {
    expect(joinedClientName([{ full_name: "Ana Pérez" }])).toBe("Ana Pérez");
  });

  it("falls back to (sin nombre) for null / empty / whitespace", () => {
    expect(joinedClientName(null)).toBe("(sin nombre)");
    expect(joinedClientName(undefined)).toBe("(sin nombre)");
    expect(joinedClientName([])).toBe("(sin nombre)");
    expect(joinedClientName({ full_name: "   " })).toBe("(sin nombre)");
  });
});

const NOW = new Date("2026-07-20T13:00:00Z").getTime();
const daysAgo = (n: number) =>
  new Date(NOW - n * 86_400_000).toISOString();

function session(over: Partial<RemindedSession> = {}): RemindedSession {
  return {
    reminder_sent_at: daysAgo(1),
    confirmed_at: null,
    status: "scheduled",
    ...over,
  };
}

describe("reminderMetrics", () => {
  it("counts sent / confirmed / rescheduled inside the 7-day window", () => {
    const m = reminderMetrics(
      [
        session({ confirmed_at: daysAgo(0.5) }), // responded: confirm
        session({ status: "reschedule_requested" }), // responded: resched
        session(), // no response
        session({ reminder_sent_at: daysAgo(10) }), // outside the window
        session({ reminder_sent_at: null }), // never reminded
      ],
      NOW,
    );
    expect(m).toEqual({
      sent: 3,
      confirmed: 1,
      rescheduled: 1,
      responseRate: 2 / 3,
    });
  });

  it("zero sends → null rate, no division by zero", () => {
    expect(reminderMetrics([], NOW)).toEqual({
      sent: 0,
      confirmed: 0,
      rescheduled: 0,
      responseRate: null,
    });
  });

  it("a session with both signals counts once, as reschedule", () => {
    const m = reminderMetrics(
      [
        session({
          confirmed_at: daysAgo(0.9),
          status: "reschedule_requested", // confirmed first, then asked to move
        }),
      ],
      NOW,
    );
    expect(m.sent).toBe(1);
    expect(m.confirmed).toBe(0);
    expect(m.rescheduled).toBe(1);
    expect(m.responseRate).toBe(1);
  });

  it("a session cancelled after its reminder is excluded entirely", () => {
    const m = reminderMetrics(
      [
        session({ status: "cancelled" }), // reminded, then shop cancelled
        session({ confirmed_at: daysAgo(0.5) }),
      ],
      NOW,
    );
    expect(m.sent).toBe(1); // the cancelled one is neither sent nor response
    expect(m.responseRate).toBe(1);
  });

  it("window boundaries: exactly 7 days ago is in; the future is out", () => {
    const m = reminderMetrics(
      [
        session({ reminder_sent_at: daysAgo(7) }), // boundary → included
        session({ reminder_sent_at: daysAgo(-1) }), // future timestamp → out
      ],
      NOW,
    );
    expect(m.sent).toBe(1);
  });

  it("the §11 target is comparable against the rate", () => {
    const below = reminderMetrics(
      [session(), session(), session({ confirmed_at: daysAgo(0.1) })],
      NOW,
    );
    expect(below.responseRate! < RESPONSE_TARGET).toBe(true);
    const above = reminderMetrics(
      [session({ confirmed_at: daysAgo(0.1) })],
      NOW,
    );
    expect(above.responseRate! >= RESPONSE_TARGET).toBe(true);
  });
});

describe("missedReminders", () => {
  // now = 2026-07-20 22:00 Montevideo (2026-07-21 01:00Z) — AFTER the last
  // batch (21:00), so a still-null tomorrow reminder is a genuine miss.
  // tomorrow = 2026-07-21 local.
  const NOW_MVD = new Date("2026-07-21T01:00:00Z").getTime();
  const tomorrowAt = (localTime: string) =>
    new Date(`2026-07-21T${localTime}-03:00`).toISOString();

  function s(over: Partial<ReminderCheckSession> = {}): ReminderCheckSession {
    return {
      id: "s-1",
      client_id: "c-1",
      full_name: "Ana Inventada",
      starts_at: tomorrowAt("15:00"),
      reminder_sent_at: null,
      status: "scheduled",
      source: "manual",
      ...over,
    };
  }

  it("flags a tomorrow session with no reminder sent", () => {
    const out = missedReminders([s()], NOW_MVD);
    expect(out).toHaveLength(1);
    expect(out[0].full_name).toBe("Ana Inventada");
  });

  it("does NOT flag a session whose reminder already went out", () => {
    expect(missedReminders([s({ reminder_sent_at: tomorrowAt("00:00") })], NOW_MVD)).toHaveLength(0);
  });

  it("does NOT flag External sessions (External reminds its own)", () => {
    expect(missedReminders([s({ source: "external" })], NOW_MVD)).toHaveLength(0);
  });

  it("does NOT flag cancelled or reschedule-requested sessions", () => {
    expect(missedReminders([s({ status: "cancelled" })], NOW_MVD)).toHaveLength(0);
    expect(missedReminders([s({ status: "reschedule_requested" })], NOW_MVD)).toHaveLength(0);
  });

  it("only looks at TOMORROW — today and day-after are out of scope", () => {
    const today = new Date("2026-07-20T18:00:00-03:00").toISOString();
    const dayAfter = new Date("2026-07-22T15:00:00-03:00").toISOString();
    expect(missedReminders([s({ starts_at: today }), s({ starts_at: dayAfter })], NOW_MVD)).toHaveLength(0);
  });

  it("catches a late-night tomorrow session (23:30 local) and an early one (00:15)", () => {
    const out = missedReminders(
      [s({ id: "late", starts_at: tomorrowAt("23:30") }), s({ id: "early", starts_at: tomorrowAt("00:15") })],
      NOW_MVD,
    );
    expect(out).toHaveLength(2);
  });

  it("returns them sorted by start time", () => {
    const out = missedReminders(
      [s({ id: "b", starts_at: tomorrowAt("17:00") }), s({ id: "a", starts_at: tomorrowAt("09:00") })],
      NOW_MVD,
    );
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("does NOT flag a manual session covered by a same-day External twin", () => {
    // Client c-1 has a manual session tomorrow AND a External session the same
    // Montevideo day → External reminds her, so the manual null reminder is not
    // a miss (issue #69 twin rule). Regression for the reviewer-caught bug.
    const covered = externalCoveredKeys([
      { client_id: "c-1", starts_at: tomorrowAt("18:00") },
    ]);
    expect(missedReminders([s({ client_id: "c-1" })], NOW_MVD, covered)).toHaveLength(0);
  });

  it("still flags a session whose client's External is on a DIFFERENT day", () => {
    const covered = externalCoveredKeys([
      { client_id: "c-1", starts_at: new Date("2026-07-22T18:00:00-03:00").toISOString() },
    ]);
    expect(missedReminders([s({ client_id: "c-1" })], NOW_MVD, covered)).toHaveLength(1);
  });

  it("returns NOTHING before the last batch (21:00) — a catch-up may still send", () => {
    // 2026-07-20 18:00 Montevideo: the 16:00 batch ran, but the 21:00 catch-up
    // hasn't — a session that appeared via sync after 16:00 still gets a shot,
    // so a null reminder is not yet a miss.
    const before21 = new Date("2026-07-20T21:00:00Z").getTime(); // 18:00 -03:00
    expect(missedReminders([s()], before21)).toHaveLength(0);
  });

  it("DOES flag after 21:00 (last batch is done and the reminder is still null)", () => {
    const at21 = new Date("2026-07-21T00:00:00Z").getTime(); // 21:00 -03:00
    expect(missedReminders([s()], at21)).toHaveLength(1);
  });

  it("dedupes a client with two DB rows at the same slot (dirty data)", () => {
    // Two scheduled rows, same client, same time → one alert entry.
    const dup = [
      s({ id: "row-a", client_id: "c-1", starts_at: tomorrowAt("19:00") }),
      s({ id: "row-b", client_id: "c-1", starts_at: tomorrowAt("19:00") }),
    ];
    expect(missedReminders(dup, NOW_MVD)).toHaveLength(1);
  });

  it("does NOT dedupe two DIFFERENT clients at the same time", () => {
    const two = [
      s({ id: "row-a", client_id: "c-1", starts_at: tomorrowAt("19:00") }),
      s({ id: "row-b", client_id: "c-2", starts_at: tomorrowAt("19:00") }),
    ];
    expect(missedReminders(two, NOW_MVD)).toHaveLength(2);
  });
});

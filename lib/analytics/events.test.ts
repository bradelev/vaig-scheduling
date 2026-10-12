// Invented data only.
import { describe, expect, it } from "vitest";
import { FUNNEL_EVENTS, validateTrackedEvent } from "./events";

const KEY = "11111111-2222-3333-4444-555555555555";
const SVC = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("validateTrackedEvent — the anon endpoint accepts nothing else", () => {
  it("accepts a full row and normalizes the slot to ISO", () => {
    const res = validateTrackedEvent({
      k: KEY,
      e: "no_slots_seen",
      s: SVC,
      st: "lu",
      w: "2026-09-15",
      t: "2026-09-15T14:00:00-03:00",
    });
    expect(res).toEqual({
      ok: true,
      row: {
        session_key: KEY,
        event: "no_slots_seen",
        booking_service_id: SVC,
        staff_id: "lu",
        week_key: "2026-09-15",
        slot_at: "2026-09-15T17:00:00.000Z",
      },
    });
  });

  it("accepts the minimal shape (key + event)", () => {
    expect(validateTrackedEvent({ k: KEY, e: "page_view" })).toMatchObject({
      ok: true,
      row: { event: "page_view", booking_service_id: null, staff_id: null, week_key: null, slot_at: null },
    });
  });

  it("rejects a bad session key, an unknown event, and junk dimensions", () => {
    expect(validateTrackedEvent({ k: "nope", e: "page_view" })).toEqual({ error: "bad session key" });
    expect(validateTrackedEvent({ k: KEY, e: "drop table" })).toEqual({ error: "bad event" });
    expect(validateTrackedEvent({ k: KEY, e: "page_view", s: "not-a-uuid" })).toEqual({ error: "bad service" });
    expect(validateTrackedEvent({ k: KEY, e: "page_view", st: "lu; --" })).toEqual({ error: "bad staff" });
    expect(validateTrackedEvent({ k: KEY, e: "page_view", w: "2026-99-99" })).toEqual({ error: "bad week" });
    expect(validateTrackedEvent({ k: KEY, e: "page_view", t: "mañana" })).toEqual({ error: "bad slot" });
    expect(validateTrackedEvent(null)).toEqual({ error: "bad session key" });
  });

  it("the event list matches the DB CHECK (10 events, no drift)", () => {
    expect(FUNNEL_EVENTS).toHaveLength(10);
    for (const e of FUNNEL_EVENTS) {
      expect(validateTrackedEvent({ k: KEY, e })).toMatchObject({ ok: true });
    }
  });
});

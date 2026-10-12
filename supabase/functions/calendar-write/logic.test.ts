/**
 * Unit tests for the pure logic of calendar-write (issue #118), against
 * fixtures only — no network, no database. All personal data is invented.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  APP_MARKER_KEY,
  APP_MARKER_VALUE,
  buildMirrorEvent,
  eventIdForSession,
  isAppManaged,
  type MirrorSession,
  mirrorEnd,
  mirrorSummary,
  SESSION_ID_KEY,
  TIMEZONE,
} from "./logic.ts";

const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const session = (over: Partial<MirrorSession> = {}): MirrorSession => ({
  id: UUID,
  starts_at: "2026-08-10T17:00:00.000Z",
  ends_at: "2026-08-10T18:30:00.000Z",
  client_name: "Alba Inventada",
  service: "depilacion",
  ...over,
});

Deno.test("eventIdForSession is deterministic and Google-valid (a-v0-9)", () => {
  const id = eventIdForSession(UUID);
  assertEquals(id, eventIdForSession(UUID)); // deterministic
  assertEquals(id, "vaig3f2504e04f8941d39a0c0305e82c3301");
  assert(/^[a-v0-9]+$/.test(id), "must be base32hex per Google's rule");
});

Deno.test("eventIdForSession rejects a non-uuid", () => {
  assertThrows(() => eventIdForSession("not-a-uuid-zzz"));
});

Deno.test("mirrorSummary is '📌 Name — Category' with the visible app prefix", () => {
  assertEquals(mirrorSummary(session()), "📌 Alba Inventada — depilacion");
  assertEquals(
    mirrorSummary(session({ service: null })),
    "📌 Alba Inventada",
  );
  // The INVISIBLE ownership marker still never appears in the title (the 📌 is
  // the human-facing marker; APP_MARKER_KEY lives in extendedProperties).
  assert(!mirrorSummary(session()).includes(APP_MARKER_KEY));
});

Deno.test("mirrorEnd uses ends_at, or starts_at + 60m when null", () => {
  assertEquals(mirrorEnd(session()), "2026-08-10T18:30:00.000Z");
  assertEquals(
    mirrorEnd(session({ ends_at: null })),
    "2026-08-10T18:00:00.000Z", // 17:00 + 60m
  );
});

Deno.test("buildMirrorEvent carries the marker + session id in extendedProperties", () => {
  const ev = buildMirrorEvent(session());
  assertEquals(ev.id, "vaig3f2504e04f8941d39a0c0305e82c3301");
  assertEquals(ev.extendedProperties.private[APP_MARKER_KEY], APP_MARKER_VALUE);
  assertEquals(ev.extendedProperties.private[SESSION_ID_KEY], UUID);
  assertEquals(ev.start.timeZone, TIMEZONE);
  assertEquals(ev.end.timeZone, TIMEZONE);
  assertEquals(ev.start.dateTime, "2026-08-10T17:00:00.000Z");
});

Deno.test("buildMirrorEvent sets colorId (as a string) for a valid 1–11 color", () => {
  assertEquals(buildMirrorEvent(session({ color_id: 3 })).colorId, "3");
  assertEquals(buildMirrorEvent(session({ color_id: 10 })).colorId, "10");
});

Deno.test("buildMirrorEvent OMITS colorId when null/absent/out-of-range (default color)", () => {
  // null / undefined → no colorId → the event keeps the calendar default.
  assertEquals(buildMirrorEvent(session({ color_id: null })).colorId, undefined);
  assertEquals(buildMirrorEvent(session()).colorId, undefined);
  // Out of the 1–11 range or non-integer is ignored, never sent to Google.
  assertEquals(buildMirrorEvent(session({ color_id: 0 })).colorId, undefined);
  assertEquals(buildMirrorEvent(session({ color_id: 12 })).colorId, undefined);
  assertEquals(buildMirrorEvent(session({ color_id: 3.5 })).colorId, undefined);
});

Deno.test("isAppManaged detects our own events and ignores external/manual", () => {
  assert(isAppManaged(buildMirrorEvent(session())));
  assert(!isAppManaged({})); // a bare external/manual event
  assert(!isAppManaged({ extendedProperties: { private: {} } }));
  assert(
    !isAppManaged({ extendedProperties: { private: { other: "x" } } }),
  );
});

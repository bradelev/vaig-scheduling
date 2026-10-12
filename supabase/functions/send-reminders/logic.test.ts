/**
 * Unit tests for the pure logic of send-reminders (issue E4-T2), against
 * fixtures only — no network, no database. All personal data is invented.
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  buildTemplatePayload,
  type Candidate,
  dedupeByClientDay,
  firstName,
  formatReminderDate,
  formatReminderTime,
  localDayKey,
  needsImmediateReminder,
  nextLocalDayWindow,
  phoneLast4,
  redactPhones,
  remindedKeys,
  TEMPLATE_NO_SERVICE,
  TEMPLATE_WITH_SERVICE,
  waPhone,
} from "./logic.ts";

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    id: "s-1",
    client_id: "c-1",
    starts_at: "2026-07-15T17:30:00Z",
    service: "maderoterapia",
    full_name: "Alba Inventada",
    phone: "+59891234567",
    ...over,
  };
}

Deno.test("formatReminderDate/formatReminderTime: plain Montevideo time (UTC-3)", () => {
  assertEquals(formatReminderDate("2026-07-15T17:30:00Z"), "mié 15/07");
  assertEquals(formatReminderTime("2026-07-15T17:30:00Z"), "14:30");
});

Deno.test("formatReminderDate/formatReminderTime: midnight boundary crosses into the previous local day", () => {
  // 02:00Z on the 16th is 23:00 on the 15th in Montevideo.
  assertEquals(formatReminderDate("2026-07-16T02:00:00Z"), "mié 15/07");
  assertEquals(formatReminderTime("2026-07-16T02:00:00Z"), "23:00");
});

Deno.test("localDayKey: keys on the Montevideo calendar day, not the UTC day", () => {
  assertEquals(localDayKey("2026-07-16T02:00:00Z"), "2026-07-15");
  assertEquals(localDayKey("2026-07-15T17:30:00Z"), "2026-07-15");
});

Deno.test("firstName: takes the first token and trims surrounding whitespace", () => {
  assertEquals(firstName("Alba Inventada Pérez"), "Alba");
  assertEquals(firstName("  Flor  "), "Flor");
  assertEquals(firstName(""), "");
});

Deno.test("waPhone: strips a leading + and leaves numbers without one unchanged", () => {
  assertEquals(waPhone("+59891234567"), "59891234567");
  assertEquals(waPhone("59891234567"), "59891234567");
});

Deno.test("phoneLast4: only the last 4 digits (CLAUDE.md sensitive-data rule)", () => {
  assertEquals(phoneLast4("+59891234567"), "4567");
});

Deno.test("redactPhones: 7+ digit runs collapse to their last 4", () => {
  assertEquals(
    redactPhones('{"message":"Invalid recipient +59891234567"}'),
    '{"message":"Invalid recipient +***4567"}',
  );
  // Short digit runs (error codes, indexes) stay readable.
  assertEquals(redactPhones("code 100, index 0"), "code 100, index 0");
});

Deno.test("buildTemplatePayload: blank (not only null) service uses the no-service variant (issue #75)", () => {
  const payload = buildTemplatePayload(candidate({ service: "  " })) as {
    template: {
      name: string;
      components: { type: string; parameters?: { text?: string }[] }[];
    };
  };
  assertEquals(payload.template.name, TEMPLATE_NO_SERVICE);
  const body = payload.template.components.find((c) => c.type === "body");
  // 3 params, none of them "tratamiento": name, date, time.
  assertEquals(body?.parameters?.map((p) => p.text), ["Alba", "mié 15/07", "14:30"]);
});

Deno.test("remindedKeys: builds a client|local-day set from already-reminded rows", () => {
  const keys = remindedKeys([
    { client_id: "c-1", starts_at: "2026-07-16T02:00:00Z" },
  ]);
  assertEquals(keys.size, 1);
  assertEquals(keys.has("c-1|2026-07-15"), true);
});

Deno.test("dedupeByClientDay: earliest session of the day wins, same-day duplicates and already-reminded clients are skipped", () => {
  const a = candidate({ id: "a", client_id: "c-1", starts_at: "2026-07-15T17:30:00Z" });
  const b = candidate({ id: "b", client_id: "c-1", starts_at: "2026-07-15T20:00:00Z" });
  const c = candidate({ id: "c", client_id: "c-2", starts_at: "2026-07-15T18:00:00Z" });
  const alreadyReminded = new Set(["c-2|2026-07-15"]);

  const result = dedupeByClientDay([a, b, c], alreadyReminded);

  assertEquals(result.toSend.map((s) => s.id), ["a"]);
  assertEquals(
    new Map(result.skipped.map((s) => [s.session_id, s.reason])),
    new Map([
      ["b", "duplicate_in_batch"],
      ["c", "already_reminded_same_day"],
    ]),
  );
});

Deno.test("dedupeByClientDay: input order does not matter, earliest still wins", () => {
  const a = candidate({ id: "a", client_id: "c-1", starts_at: "2026-07-15T17:30:00Z" });
  const b = candidate({ id: "b", client_id: "c-1", starts_at: "2026-07-15T20:00:00Z" });
  const c = candidate({ id: "c", client_id: "c-2", starts_at: "2026-07-15T18:00:00Z" });
  const alreadyReminded = new Set(["c-2|2026-07-15"]);

  // b (later) is passed before a (earlier).
  const result = dedupeByClientDay([b, a, c], alreadyReminded);

  assertEquals(result.toSend.map((s) => s.id), ["a"]);
  assertEquals(
    new Map(result.skipped.map((s) => [s.session_id, s.reason])),
    new Map([
      ["b", "duplicate_in_batch"],
      ["c", "already_reminded_same_day"],
    ]),
  );
});

Deno.test("buildTemplatePayload: no-service payload keeps the session-scoped buttons (issue #75)", () => {
  const c = candidate({
    id: "s-9",
    service: null,
    full_name: "Alba Inventada",
    phone: "+59891234567",
    starts_at: "2026-07-15T17:30:00Z",
  });

  const payload = buildTemplatePayload(c) as {
    to: string;
    template: {
      name: string;
      language: { code: string };
      components: {
        type: string;
        parameters?: { type: string; text?: string; payload?: string }[];
      }[];
    };
  };

  assertEquals(payload.to, "59891234567");
  assertEquals(payload.template.name, TEMPLATE_NO_SERVICE);
  assertEquals(payload.template.language.code, "es_UY");

  const body = payload.template.components.find((comp) => comp.type === "body");
  const bodyTexts = body?.parameters?.map((p) => p.text);
  assertEquals(bodyTexts, ["Alba", "mié 15/07", "14:30"]);

  const buttons = payload.template.components.filter((comp) => comp.type === "button");
  assertEquals(buttons.map((b) => b.parameters?.[0].payload), [
    "CONFIRM_s-9",
    "RESCHED_s-9",
  ]);
});

Deno.test("buildTemplatePayload: overrideTo replaces only the destination (issue #60)", () => {
  const c = candidate({ id: "s-real", phone: "+59891234567" });
  const payload = buildTemplatePayload(c, "+59898000001") as {
    to: string;
    template: {
      components: {
        type: string;
        parameters: { type: string; text?: string; payload?: string }[];
      }[];
    };
  };
  // Destination is the rehearsal phone, Graph-formatted (no +)…
  assertEquals(payload.to, "59898000001");
  // …but the buttons still carry the REAL session id, so tapping them in a
  // rehearsal exercises the exact webhook path production would.
  const buttons = payload.template.components.filter((x) => x.type === "button");
  assertEquals(buttons[0].parameters[0].payload, "CONFIRM_s-real");
  assertEquals(buttons[1].parameters[0].payload, "RESCHED_s-real");
});

Deno.test("buildTemplatePayload: a known service keeps the original 4-param template (issue #75)", () => {
  const payload = buildTemplatePayload(candidate({ service: "maderoterapia" })) as {
    template: {
      name: string;
      components: { type: string; parameters?: { text?: string; payload?: string }[] }[];
    };
  };
  assertEquals(payload.template.name, TEMPLATE_WITH_SERVICE);
  const body = payload.template.components.find((c) => c.type === "body");
  assertEquals(body?.parameters?.map((p) => p.text), [
    "Alba",
    "maderoterapia",
    "mié 15/07",
    "14:30",
  ]);
  const buttons = payload.template.components.filter((c) => c.type === "button");
  assertEquals(buttons[0].parameters?.[0].payload, "CONFIRM_s-1");
});

Deno.test("nextLocalDayWindow: 16:00 run covers the whole next Montevideo day (issue #78)", () => {
  // 16:00 MVD on the 23rd → [24th 00:00, 25th 00:00) local = 03:00Z bounds.
  assertEquals(nextLocalDayWindow(new Date("2026-07-23T19:00:00Z")), {
    fromIso: "2026-07-24T03:00:00.000Z",
    toIso: "2026-07-25T03:00:00.000Z",
  });
});

Deno.test("nextLocalDayWindow: a 09:00 next-day session is inside the window (issue #78)", () => {
  // The case the rolling now+24h window missed: session 24/07 09:00 MVD
  // (12:00Z) seen from a 23/07 16:00 MVD run.
  const w = nextLocalDayWindow(new Date("2026-07-23T19:00:00Z"));
  const session = "2026-07-24T12:00:00.000Z";
  assertEquals(w.fromIso <= session && session < w.toIso, true);
});

Deno.test("nextLocalDayWindow: UTC rollover keeps the Montevideo day (issue #78)", () => {
  // 21:38 MVD on the 23rd is already 00:38Z on the 24th; the next LOCAL
  // day is still the 24th.
  assertEquals(nextLocalDayWindow(new Date("2026-07-24T00:38:00Z")), {
    fromIso: "2026-07-24T03:00:00.000Z",
    toIso: "2026-07-25T03:00:00.000Z",
  });
});

Deno.test("nextLocalDayWindow: month boundary rolls cleanly (issue #78)", () => {
  // 31/07 16:00 MVD → the next local day is 01/08.
  assertEquals(nextLocalDayWindow(new Date("2026-07-31T19:00:00Z")), {
    fromIso: "2026-08-01T03:00:00.000Z",
    toIso: "2026-08-02T03:00:00.000Z",
  });
});

// --- v3 dedup for app-origin sessions (issue #119) --------------------------
// The dedup key is client|day and source-agnostic, so app sessions must dedup
// exactly like manual ones. These pin that guarantee so a future change can't
// silently double- or drop-remind an app-created session.

Deno.test("dedupeByClientDay (#119): an app session + a External booking same day → ONE reminder", () => {
  // The app session is a candidate (external is excluded from candidates at the
  // query level); externalCovered marks the client|day, so the app session is
  // skipped in favor of External's own reminder — never two messages.
  const app = candidate({ id: "app-1", client_id: "c-1", starts_at: "2026-07-15T17:00:00Z" });
  const externalCovered = new Set(["c-1|2026-07-15"]);

  const result = dedupeByClientDay([app], new Set(), externalCovered);

  assertEquals(result.toSend.map((s) => s.id), []);
  assertEquals(
    new Map(result.skipped.map((s) => [s.session_id, s.reason])),
    new Map([["app-1", "external_covers_same_day"]]),
  );
});

Deno.test("dedupeByClientDay (#119): two app sessions for the same client/day → ONE reminder (earliest)", () => {
  const early = candidate({ id: "app-e", client_id: "c-1", starts_at: "2026-07-15T09:00:00Z" });
  const late = candidate({ id: "app-l", client_id: "c-1", starts_at: "2026-07-15T15:00:00Z" });

  const result = dedupeByClientDay([late, early], new Set());

  assertEquals(result.toSend.map((s) => s.id), ["app-e"]);
  assertEquals(
    new Map(result.skipped.map((s) => [s.session_id, s.reason])),
    new Map([["app-l", "duplicate_in_batch"]]),
  );
});

Deno.test("dedupeByClientDay (#119): an app session already reminded that day → skipped", () => {
  const app = candidate({ id: "app-r", client_id: "c-1", starts_at: "2026-07-15T17:00:00Z" });
  const alreadyReminded = new Set(["c-1|2026-07-15"]);

  const result = dedupeByClientDay([app], alreadyReminded);

  assertEquals(result.toSend.map((s) => s.id), []);
  assertEquals(
    new Map(result.skipped.map((s) => [s.session_id, s.reason])),
    new Map([["app-r", "already_reminded_same_day"]]),
  );
});

Deno.test("dedupeByClientDay (#119): app sessions on DIFFERENT days both remind", () => {
  const day1 = candidate({ id: "app-d1", client_id: "c-1", starts_at: "2026-07-15T17:00:00Z" });
  const day2 = candidate({ id: "app-d2", client_id: "c-1", starts_at: "2026-07-16T17:00:00Z" });

  const result = dedupeByClientDay([day1, day2], new Set());

  assertEquals(result.toSend.map((s) => s.id).sort(), ["app-d1", "app-d2"]);
  assertEquals(result.skipped, []);
});

Deno.test("dedupeByClientDay (#119): mirror-only misread — an UNMARKED duplicate of an app session dedups by client|day (secondary defense)", () => {
  // Realistic bypass of the primary (marker) defense: a staffer duplicates an
  // app-created event in Google Calendar's UI, which does NOT preserve the
  // vaigApp extended property. The sync ingests it as a plain source='manual'
  // session — same client, same day as the real app session. The client|day
  // key (secondary defense) must collapse the two to ONE reminder.
  const appSession = candidate({ id: "app-real", client_id: "c-1", starts_at: "2026-07-15T14:00:00Z" });
  const unmarkedDup = candidate({ id: "manual-dup", client_id: "c-1", starts_at: "2026-07-15T14:00:00Z" });

  const result = dedupeByClientDay([appSession, unmarkedDup], new Set());

  assertEquals(result.toSend.length, 1); // exactly one, never two
  assertEquals(result.skipped.map((s) => s.reason), ["duplicate_in_batch"]);
});

Deno.test("dedupeByClientDay (#119): Montevideo day boundary — a 23:30-local app session keys to the local day, not UTC", () => {
  // 2026-07-15T23:30 in Montevideo is 2026-07-16T02:30Z. clientDayKey must key
  // it to the 15th (local), so a External booking earlier the SAME local day
  // covers it — a naive UTC-day key would put them on different days and send
  // a duplicate.
  const appLate = candidate({ id: "app-2330", client_id: "c-1", starts_at: "2026-07-16T02:30:00Z" }); // 23:30 -03
  // The coverage set is keyed `${clientId}|${localDayKey(iso)}` (same shape the
  // pipeline builds). A external booking at 18:00 the same LOCAL day.
  const externalSameLocalDay = new Set([`c-1|${localDayKey("2026-07-15T18:00:00-03:00")}`]);

  const result = dedupeByClientDay([appLate], new Set(), externalSameLocalDay);

  assertEquals(result.toSend.length, 0); // covered by the same-local-day external
  assertEquals(result.skipped.map((s) => s.reason), ["external_covers_same_day"]);
});

// --- immediate reminder for late-created sessions (issue #120) --------------
// All instants are in America/Montevideo (UTC-3, no DST). "now" and the
// session start are chosen to pin each boundary.

Deno.test("needsImmediateReminder: tomorrow session created AFTER 16:00 today → immediate", () => {
  // now = 2026-07-15 17:00 MVD (20:00Z); session = 2026-07-16 10:00 MVD.
  const now = new Date("2026-07-15T20:00:00Z");
  assertEquals(needsImmediateReminder("2026-07-16T13:00:00Z", now), true);
});

Deno.test("needsImmediateReminder: tomorrow session created BEFORE 16:00 today → NOT immediate (batch covers it)", () => {
  // now = 2026-07-15 10:00 MVD (13:00Z); today's batch hasn't run yet.
  const now = new Date("2026-07-15T13:00:00Z");
  assertEquals(needsImmediateReminder("2026-07-16T13:00:00Z", now), false);
});

Deno.test("needsImmediateReminder: exactly 16:00 MVD counts as after (batch is running) → immediate", () => {
  // now = 2026-07-15 16:00 MVD (19:00Z) — the batch fires at this instant.
  const now = new Date("2026-07-15T19:00:00Z");
  assertEquals(needsImmediateReminder("2026-07-16T13:00:00Z", now), true);
});

Deno.test("needsImmediateReminder: session 2+ days out → NOT immediate (a future batch covers it)", () => {
  const now = new Date("2026-07-15T20:00:00Z"); // after 16:00
  assertEquals(needsImmediateReminder("2026-07-17T13:00:00Z", now), false);
});

Deno.test("needsImmediateReminder: same-day session → NOT immediate (past the day-before horizon)", () => {
  const now = new Date("2026-07-15T20:00:00Z");
  assertEquals(needsImmediateReminder("2026-07-15T23:00:00Z", now), false);
});

Deno.test("needsImmediateReminder: day-boundary — a 23:30-local-tomorrow session still counts as tomorrow", () => {
  // now = 2026-07-15 18:00 MVD; session = 2026-07-16 23:30 MVD (2026-07-17 02:30Z).
  // Must key to the 16th (tomorrow), not the 17th, so it's immediate.
  const now = new Date("2026-07-15T21:00:00Z");
  assertEquals(needsImmediateReminder("2026-07-17T02:30:00Z", now), true);
});

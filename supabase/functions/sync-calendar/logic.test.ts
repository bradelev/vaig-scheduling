/**
 * Pure classification (§7.0) and cascade (§7.2) tests for sync-calendar
 * (issue E2-T3), run against the E2-T2 fixtures. All data is invented.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  chunked,
  classify,
  extractPhones,
  matchableText,
  matchEvent,
  type RawEvent,
} from "./logic.ts";
import { tokens } from "../../../lib/normalize.ts";
import fixture from "../../../fixtures/gcal-events.json" with { type: "json" };

const events = fixture.items as RawEvent[];
const byId = (suffix: string) =>
  events.find((e) => e.id.endsWith(suffix))!;

Deno.test("§7.0 classifies the fixtures into the expected buckets", () => {
  const buckets: Record<string, number> = {};
  for (const ev of events) {
    const c = classify(ev);
    const key = c.kind === "discard" ? c.reason : "session";
    buckets[key] = (buckets[key] ?? 0) + 1;
  }
  // 17 sessions (2 of them cancelled but session-shaped: ko03, ma10).
  // em05 "Lu no, médico" is cancelled but availability-shaped, so discards
  // win — it stays in employee_availability, never becomes a session row.
  assertEquals(buckets, {
    session: 17,
    all_day: 2,
    employee_availability: 4,
    admin_chore: 7,
  });
});

Deno.test("§7.0 discards employee availability including the Stephy nickname", () => {
  assertEquals(classify(byId("em03")).kind, "discard"); // "Stephy no"
  const c = classify(byId("em03"));
  assert(c.kind === "discard" && c.reason === "employee_availability");
});

Deno.test("§7.0 discards employee shift blocks as chores, not sessions", () => {
  for (const id of ["em06", "em07"]) {
    const c = classify(byId(id)); // "Iara de 7:30 a 16:30 (9)", "Lu de 13…"
    assert(c.kind === "discard" && c.reason === "admin_chore", byId(id).summary);
  }
});

Deno.test("§7.0 does NOT discard a client whose name starts like an employee", () => {
  // A External session for the employee "iara" as a real client stays.
  const c = classify(byId("ko05")); // "External - Cita con iara 59894445566"
  assert(c.kind === "session");
});

Deno.test("§7.0 marks cancelled events as sessions with cancelled status", () => {
  const c = classify(byId("ko03")); // cancelled External
  assert(c.kind === "session" && c.status === "cancelled");
});

Deno.test("source detection: External prefix vs manual", () => {
  const external = classify(byId("ko01"));
  const manual = classify(byId("ma01"));
  assert(external.kind === "session" && external.source === "external");
  assert(manual.kind === "session" && manual.source === "manual");
});

Deno.test("matchableText strips the External prefix before tokenizing", () => {
  assertEquals(
    tokens(matchableText("external", "External - Cita con Ana Motta")),
    ["ana", "motta"],
  );
  // Manual titles pass through.
  assertEquals(matchableText("manual", "Ana Motta pe 3/8"), "Ana Motta pe 3/8");
});

Deno.test("extractPhones finds unbracketed External and embedded manual phones", () => {
  assertEquals(
    extractPhones("External - Cita con Agustina Piriz 59891112233", null),
    ["+59891112233"],
  );
  assertEquals(
    extractPhones("Estefanía Curbelo axilas 6/6 y piernas 091112223", null),
    ["+59891112223"],
  );
  // Invalid digit run → not extracted.
  assertEquals(extractPhones("Tamara uñas tel 12345", null), []);
});

Deno.test("cascade step 1: phone match against a known client", () => {
  const clients = new Map([["+59891112233", "client-a"]]);
  const r = matchEvent(
    { phones: ["+59891112233"], eventTokens: ["agustina", "piriz"] },
    clients,
    [],
  );
  assert(r.method === "phone" && r.client_id === "client-a");
  assertEquals(r.learnAlias, ["agustina", "piriz"]); // learning bonus
});

Deno.test("cascade step 1: phone present but unknown → falls through", () => {
  const r = matchEvent(
    { phones: ["+59899998888"], eventTokens: ["nadie", "conocido"] },
    new Map(),
    [],
  );
  assertEquals(r.method, null);
});

Deno.test("cascade step 2: exactly one alias subset match wins", () => {
  const aliases = [
    { client_id: "c1", alias_tokens: ["ana", "motta"] },
    { client_id: "c2", alias_tokens: ["bea", "diaz"] },
  ];
  const r = matchEvent(
    { phones: [], eventTokens: ["ana", "motta", "lifting"] },
    new Map(),
    aliases,
  );
  assert(r.method === "alias" && r.client_id === "c1");
});

Deno.test("cascade step 2: ambiguous (>1) → queue with candidates", () => {
  const aliases = [
    { client_id: "c1", alias_tokens: ["ana"] },
    { client_id: "c2", alias_tokens: ["ana"] },
  ];
  const r = matchEvent({ phones: [], eventTokens: ["ana"] }, new Map(), aliases);
  assertEquals(r.method, null);
  assert(r.method === null && r.candidates.length === 2);
});

Deno.test("cascade step 3: no phone, no alias → queue", () => {
  const r = matchEvent(
    { phones: [], eventTokens: ["persona", "nueva"] },
    new Map(),
    [],
  );
  assertEquals(r.method, null);
  assert(r.method === null && r.candidates.length === 0);
});

Deno.test("cascade never fuzzy-matches: a strict superset alias does not match", () => {
  // alias needs BOTH tokens; event has only one → no match (§3 no fuzzy).
  const aliases = [{ client_id: "c1", alias_tokens: ["ana", "motta"] }];
  const r = matchEvent({ phones: [], eventTokens: ["ana"] }, new Map(), aliases);
  assertEquals(r.method, null);
});

Deno.test("classify: affirmative shift block 'STEP SI DE 9 A 12.30-13H' is discarded (issue #84)", () => {
  const c = classify({
    id: "ev-si",
    summary: "STEP SI DE 9 A 12.30-13H",
    start: { dateTime: "2026-07-27T09:00:00-03:00" },
    end: { dateTime: "2026-07-27T13:00:00-03:00" },
  });
  assertEquals(c.kind, "discard");
  // Shift blocks fall under the schedule-shape pattern (admin_chore).
  assertEquals((c as { reason: string }).reason, "admin_chore");
});

Deno.test("classify: '{employee} si' WITHOUT the hours shape stays a session (issue #84 guard)", () => {
  const c = classify({
    id: "ev-guard",
    summary: "Lu Silveira cc y ax",
    start: { dateTime: "2026-07-27T09:00:00-03:00" },
    end: { dateTime: "2026-07-27T10:00:00-03:00" },
  });
  assertEquals(c.kind, "session");
});

Deno.test("chunked: slices of `size`, order preserved, results concatenated (issue #88)", async () => {
  const items = Array.from({ length: 250 }, (_, i) => i);
  const calls: number[] = [];
  const out = await chunked(items, 100, (slice) => {
    calls.push(slice.length);
    return Promise.resolve(slice.map((n) => n * 2));
  });
  assertEquals(calls, [100, 100, 50]);
  assertEquals(out.length, 250);
  assertEquals(out[0], 0);
  assertEquals(out[249], 498);
});

Deno.test("chunked: empty input makes zero calls (issue #88)", async () => {
  let calls = 0;
  const out = await chunked([], 100, () => {
    calls++;
    return Promise.resolve([]);
  });
  assertEquals(out, []);
  assertEquals(calls, 0);
});

Deno.test("chunked: an error mid-slice propagates and stops (issue #88)", async () => {
  const calls: number[] = [];
  let threw = false;
  try {
    await chunked([1, 2, 3], 1, (slice) => {
      calls.push(slice[0]);
      return slice[0] === 2
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(slice);
    });
  } catch (err) {
    threw = String(err).includes("boom");
  }
  assertEquals(threw, true);
  assertEquals(calls, [1, 2]); // the third slice never runs
});

Deno.test("classify: app-managed mirror events are discarded (issue #118, §II.7)", () => {
  // A mirror event this app wrote (carries the vaigApp marker) must be skipped
  // as a session source — its session already lives in the DB. Re-ingesting it
  // would create a duplicate session and double the reminder.
  const c = classify({
    id: "vaig3f2504e04f8941d39a0c0305e82c3301",
    summary: "Alba Inventada — depilacion",
    start: { dateTime: "2026-08-10T14:00:00-03:00" },
    end: { dateTime: "2026-08-10T15:00:00-03:00" },
    extendedProperties: { private: { vaigApp: "1", vaigSessionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" } },
  });
  assertEquals(c.kind, "discard");
  assertEquals((c as { reason: string }).reason, "app_managed");
});

Deno.test("classify: an event WITHOUT the marker is unaffected (external/manual still route)", () => {
  const c = classify({
    id: "ma-plain",
    summary: "clienta inventada 15hs",
    start: { dateTime: "2026-08-10T15:00:00-03:00" },
    end: { dateTime: "2026-08-10T16:00:00-03:00" },
    extendedProperties: { private: { somethingElse: "x" } },
  });
  assertEquals(c.kind, "session"); // no marker → normal cascade
});

/**
 * Unit tests for the pure logic of send-review-requests (PRD §III, layer 3),
 * against fixtures only — no network, no database. All personal data is invented.
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  buildReviewPayload,
  dedupeByClient,
  firstName,
  localDayKey,
  phoneLast4,
  redactPhones,
  type ReviewCandidate,
  REVIEW_TEMPLATE,
  waPhone,
  yesterdayLocalDayWindow,
} from "./logic.ts";

function candidate(over: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    client_id: "c-1",
    full_name: "Gabriela Inventada",
    phone: "+59891234567",
    last_completed_at: "2026-08-10T18:00:00Z",
    ...over,
  };
}

Deno.test("yesterdayLocalDayWindow spans yesterday's Montevideo calendar day", () => {
  // now = 2026-08-11 09:00 Montevideo → yesterday = 2026-08-10 local.
  const now = new Date("2026-08-11T12:00:00Z"); // 09:00 -03:00
  const { fromIso, toIso } = yesterdayLocalDayWindow(now);
  // [2026-08-10 00:00, 2026-08-11 00:00) local = [03:00Z, 03:00Z next day).
  assertEquals(fromIso, "2026-08-10T03:00:00.000Z");
  assertEquals(toIso, "2026-08-11T03:00:00.000Z");
});

Deno.test("yesterdayLocalDayWindow: a late-night 'now' still resolves the right local day", () => {
  // 2026-08-11 23:30 Montevideo (02:30Z next day) → yesterday is 08-10.
  const now = new Date("2026-08-12T02:30:00Z");
  const { fromIso, toIso } = yesterdayLocalDayWindow(now);
  assertEquals(fromIso, "2026-08-10T03:00:00.000Z");
  assertEquals(toIso, "2026-08-11T03:00:00.000Z");
});

Deno.test("a session at 23:30 Montevideo yesterday falls inside the window", () => {
  const now = new Date("2026-08-11T12:00:00Z");
  const { fromIso, toIso } = yesterdayLocalDayWindow(now);
  const session = "2026-08-11T02:30:00Z"; // 2026-08-10 23:30 -03:00
  assertEquals(session >= fromIso && session < toIso, true);
});

Deno.test("a session today (not yesterday) falls OUTSIDE the window", () => {
  const now = new Date("2026-08-11T12:00:00Z");
  const { toIso } = yesterdayLocalDayWindow(now);
  const today = "2026-08-11T12:00:00Z"; // 09:00 today local
  assertEquals(today >= toIso, true);
});

Deno.test("exact midnight boundaries: yesterday 00:00 IN, today 00:00 OUT", () => {
  const now = new Date("2026-08-11T12:00:00Z");
  const { fromIso, toIso } = yesterdayLocalDayWindow(now);
  const yesterdayMidnight = "2026-08-10T03:00:00.000Z"; // 2026-08-10 00:00 -03:00
  const todayMidnight = "2026-08-11T03:00:00.000Z"; // 2026-08-11 00:00 -03:00
  // from is inclusive → yesterday's 00:00 is in; to is exclusive → today's 00:00 is out.
  assertEquals(yesterdayMidnight >= fromIso && yesterdayMidnight < toIso, true);
  assertEquals(todayMidnight >= toIso, true);
});

Deno.test("localDayKey uses Montevideo, not UTC", () => {
  // 2026-08-11T02:00Z is still 2026-08-10 23:00 in Montevideo.
  assertEquals(localDayKey("2026-08-11T02:00:00Z"), "2026-08-10");
});

Deno.test("firstName takes the first token only", () => {
  assertEquals(firstName("Gabriela Sosa Pérez"), "Gabriela");
  assertEquals(firstName("  Ana  "), "Ana");
});

Deno.test("waPhone strips the leading +", () => {
  assertEquals(waPhone("+59891234567"), "59891234567");
});

Deno.test("phoneLast4 / redactPhones keep full numbers out of logs", () => {
  assertEquals(phoneLast4("+59891234567"), "4567");
  assertEquals(redactPhones("to 59891234567 failed"), "to ***4567 failed");
});

Deno.test("dedupeByClient keeps one ask per client", () => {
  const { toSend, skipped } = dedupeByClient([
    candidate({ client_id: "c-1" }),
    candidate({ client_id: "c-1" }),
    candidate({ client_id: "c-2" }),
  ]);
  assertEquals(toSend.length, 2);
  assertEquals(skipped, [{ client_id: "c-1" }]);
});

Deno.test("buildReviewPayload: body-only, first name, no button param", () => {
  const payload = buildReviewPayload(candidate()) as {
    to: string;
    template: {
      name: string;
      language: { code: string };
      components: { type: string; parameters: { text: string }[] }[];
    };
  };
  assertEquals(payload.to, "59891234567");
  assertEquals(payload.template.name, REVIEW_TEMPLATE);
  assertEquals(payload.template.language.code, "es_UY");
  // Exactly one component (body); the Google link is the template's static URL
  // button, so NO button component is sent.
  assertEquals(payload.template.components.length, 1);
  assertEquals(payload.template.components[0].type, "body");
  assertEquals(payload.template.components[0].parameters[0].text, "Gabriela");
});

Deno.test("buildReviewPayload honors the rehearsal override for the destination only", () => {
  const payload = buildReviewPayload(candidate(), "+59899999999") as {
    to: string;
    template: { components: { parameters: { text: string }[] }[] };
  };
  assertEquals(payload.to, "59899999999");
  // Body still references the real client's first name.
  assertEquals(payload.template.components[0].parameters[0].text, "Gabriela");
});

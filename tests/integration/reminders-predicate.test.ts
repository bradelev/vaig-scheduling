/**
 * FR-2 selection predicate for send-reminders (issue E4-T2), validated
 * against the live stack: the `clients!inner` embed + embedded opted_out
 * filter is the PostgREST translation everything hinges on. KEEP THE
 * FILTER CHAIN IN SYNC with supabase/functions/send-reminders/index.ts.
 *
 * CI-only; every query filters on this file's own seed rows. All personal
 * data below is invented (CLAUDE.md sensitive-data rule).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";

const EVENT_PREFIX = "evt-fr2-";
const PHONES = { eligible: "+59892000001", optedOut: "+59892000002" } as const;

const hoursAhead = (n: number) =>
  new Date(Date.now() + n * 3_600_000).toISOString();

let service: SupabaseClient;

beforeAll(async () => {
  const { url, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);

  const { data: clients, error: clientsError } = await service
    .from("clients")
    .insert(
      [
        { full_name: "Elba Elegible", phone: PHONES.eligible },
        { full_name: "Olga Optout", phone: PHONES.optedOut, opted_out: true },
      ],
      { defaultToNull: false },
    )
    .select("id, phone");
  if (clientsError) throw new Error(`client seed failed: ${clientsError.message}`);
  const idByPhone = Object.fromEntries(clients!.map((c) => [c.phone, c.id]));
  const eligibleId = idByPhone[PHONES.eligible];

  const { error: sessionsError } = await service.from("sessions").insert(
    [
      // The single row the predicate must select.
      { gcal_event_id: `${EVENT_PREFIX}eligible`, client_id: eligibleId, starts_at: hoursAhead(36) },
      // Every exclusion, one condition at a time.
      { gcal_event_id: `${EVENT_PREFIX}cancelled`, client_id: eligibleId, starts_at: hoursAhead(30), status: "cancelled" },
      { gcal_event_id: `${EVENT_PREFIX}confirmed`, client_id: eligibleId, starts_at: hoursAhead(30), confirmed_at: hoursAhead(-1) },
      { gcal_event_id: `${EVENT_PREFIX}reminded`, client_id: eligibleId, starts_at: hoursAhead(40), reminder_sent_at: hoursAhead(-1) },
      { gcal_event_id: `${EVENT_PREFIX}unmatched`, starts_at: hoursAhead(30) },
      { gcal_event_id: `${EVENT_PREFIX}opted-out`, client_id: idByPhone[PHONES.optedOut], starts_at: hoursAhead(30) },
      { gcal_event_id: `${EVENT_PREFIX}too-soon`, client_id: eligibleId, starts_at: hoursAhead(12) },
      { gcal_event_id: `${EVENT_PREFIX}too-late`, client_id: eligibleId, starts_at: hoursAhead(50) },
      // A public-booking reservation awaiting STAFF confirmation is not a firm
      // appointment: never reminded (migration pending_confirmation).
      { gcal_event_id: `${EVENT_PREFIX}pending-confirmation`, client_id: eligibleId, starts_at: hoursAhead(30), pending_confirmation: true },
      // External sends its own reminders (issue #69): never selected…
      { gcal_event_id: `${EVENT_PREFIX}external`, client_id: eligibleId, starts_at: hoursAhead(30), source: "external" },
      // …and a CANCELLED external row must not count as coverage either.
      { gcal_event_id: `${EVENT_PREFIX}external-cancelled`, client_id: eligibleId, starts_at: hoursAhead(30), source: "external", status: "cancelled" },
    ],
    { defaultToNull: false },
  );
  if (sessionsError) throw new Error(`session seed failed: ${sessionsError.message}`);
});

afterAll(async () => {
  await service.from("sessions").delete().like("gcal_event_id", `${EVENT_PREFIX}%`);
  await service.from("clients").delete().in("phone", Object.values(PHONES));
});

describe("send-reminders FR-2 predicate (PRD §8)", () => {
  it("selects exactly the eligible session", async () => {
    const from = hoursAhead(24);
    const to = hoursAhead(48);
    const { data, error } = await service
      .from("sessions")
      .select("gcal_event_id, clients!inner(full_name, phone, opted_out)")
      .eq("status", "scheduled")
      .neq("source", "external")
      .eq("pending_confirmation", false)
      .is("confirmed_at", null)
      .is("reminder_sent_at", null)
      .not("client_id", "is", null)
      .eq("clients.opted_out", false)
      .gte("starts_at", from)
      .lt("starts_at", to)
      .like("gcal_event_id", `${EVENT_PREFIX}%`);

    expect(error).toBeNull();
    expect(data!.map((r) => r.gcal_event_id)).toEqual([
      `${EVENT_PREFIX}eligible`,
    ]);
  });

  it("external coverage query returns scheduled external rows only (issue #69)", async () => {
    // Mirrors fetchExternalCovered in send-reminders/index.ts: a cancelled
    // External booking reminds nobody, so it must NOT cover its manual twin.
    const { data, error } = await service
      .from("sessions")
      .select("gcal_event_id")
      .eq("source", "external")
      .eq("status", "scheduled")
      .gte("starts_at", hoursAhead(0))
      .lt("starts_at", hoursAhead(72))
      .like("gcal_event_id", `${EVENT_PREFIX}%`);

    expect(error).toBeNull();
    expect(data!.map((r) => r.gcal_event_id)).toEqual([
      `${EVENT_PREFIX}external`,
    ]);
  });
});

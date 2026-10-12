/**
 * v3 dedup: app-origin sessions ↔ mirror ↔ External (issue #119). CI-only,
 * against the live stack. Validates the DB-level facts the pure unit tests
 * can't: that the real FR-2 candidate predicate SELECTS an app session (gcal
 * NULL), and that the external-coverage query marks the right client/day for
 * source='app'. It does NOT run the full send composition (that lives in the
 * Deno edge runtime, unreachable from vitest) — the one-reminder guarantee
 * over these predicates is proven in send-reminders/logic.test.ts's
 * dedupeByClientDay tests. All personal data invented (+59892…).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";

const PREFIX = "evt-v3dedup-";
const PHONE_A = "+59892100001";
const PHONE_B = "+59892100002";
const hoursAhead = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

let service: SupabaseClient;
let idA = "";
let idB = "";

beforeAll(async () => {
  const { url, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);

  const { data: clients, error: cErr } = await service
    .from("clients")
    .insert(
      [
        { full_name: "Ada Inventada", phone: PHONE_A },
        { full_name: "Bruno Inventado", phone: PHONE_B },
      ],
      { defaultToNull: false },
    )
    .select("id, phone");
  if (cErr) throw new Error(`client seed failed: ${cErr.message}`);
  const byPhone = Object.fromEntries(clients!.map((c) => [c.phone, c.id]));
  idA = byPhone[PHONE_A];
  idB = byPhone[PHONE_B];

  const { error: sErr } = await service.from("sessions").insert(
    [
      // Client A: a single app session tomorrow (gcal NULL — mirror pending).
      // This must be a reminder candidate exactly like a manual one.
      { source: "app", client_id: idA, starts_at: hoursAhead(30), gcal_event_id: null },
      // Client B: an app session AND a External booking on the SAME day.
      // External reminds its own → the app session must be covered (not a 2nd msg).
      { source: "app", client_id: idB, starts_at: hoursAhead(31), gcal_event_id: null },
      { source: "external", client_id: idB, starts_at: hoursAhead(30), gcal_event_id: `${PREFIX}b-external` },
    ],
    { defaultToNull: false },
  );
  if (sErr) throw new Error(`session seed failed: ${sErr.message}`);
});

afterAll(async () => {
  if (idA) await service.from("sessions").delete().in("client_id", [idA, idB]);
  await service.from("sessions").delete().like("gcal_event_id", `${PREFIX}%`);
  await service.from("clients").delete().in("phone", [PHONE_A, PHONE_B]);
});

describe("v3 dedup: app sessions in the reminder predicate (#119)", () => {
  const from = hoursAhead(24);
  const to = hoursAhead(48);

  it("an app session (gcal NULL) IS a reminder candidate", async () => {
    // Exactly the fetchCandidates predicate from send-reminders/index.ts.
    const { data, error } = await service
      .from("sessions")
      .select("client_id, source, clients!inner(opted_out)")
      .eq("status", "scheduled")
      .neq("source", "external")
      .is("confirmed_at", null)
      .is("reminder_sent_at", null)
      .not("client_id", "is", null)
      .eq("clients.opted_out", false)
      .gte("starts_at", from)
      .lt("starts_at", to)
      .in("client_id", [idA, idB]);

    expect(error).toBeNull();
    // Both app sessions surface as candidates (A's, and B's app session);
    // the external row is excluded by .neq(source,external).
    const sources = (data ?? []).map((r) => r.source);
    expect(sources.every((s) => s === "app")).toBe(true);
    expect(data!.some((r) => r.client_id === idA)).toBe(true);
    expect(data!.some((r) => r.client_id === idB)).toBe(true);
  });

  it("client B's day is covered by the scheduled External booking (→ app session skipped)", async () => {
    // fetchExternalCovered: the scheduled external row marks client B's day, so
    // dedupeByClientDay skips B's app session (external_covers_same_day). This
    // asserts the DB side of that coverage set.
    const { data, error } = await service
      .from("sessions")
      .select("client_id")
      .eq("source", "external")
      .eq("status", "scheduled")
      .gte("starts_at", from)
      .lt("starts_at", to)
      .in("client_id", [idA, idB]);

    expect(error).toBeNull();
    const coveredClients = new Set((data ?? []).map((r) => r.client_id));
    expect(coveredClients.has(idB)).toBe(true); // B covered by external
    expect(coveredClients.has(idA)).toBe(false); // A not covered → still reminds
  });
});

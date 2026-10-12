/**
 * The reactivation loop closes (issue #53): v_reactivation hides recently
 * contacted clients (14-day grace, 60 for 'declined'). CI-only; filters on
 * its own seed rows. All personal data invented.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";

const PREFIX = "evt-loop-";
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

// Every client gets a 30-days-ago session (>21, reactivation-eligible) and
// no upcoming one; what varies is the contact state.
const CASES = [
  { key: "never", phone: "+59893000001", contact: null, outcome: null, shown: true },
  { key: "fresh-noreply", phone: "+59893000002", contact: 5, outcome: "no_reply", shown: false },
  { key: "old-noreply", phone: "+59893000003", contact: 20, outcome: "no_reply", shown: true },
  { key: "fresh-declined", phone: "+59893000004", contact: 30, outcome: "declined", shown: false },
  { key: "old-declined", phone: "+59893000005", contact: 90, outcome: "declined", shown: true },
  { key: "fresh-rebooked", phone: "+59893000006", contact: 5, outcome: "rebooked", shown: false },
  // Legacy shape: contacted via the old markContacted (outcome NULL) —
  // exactly what prod rows look like today. IS DISTINCT FROM must treat
  // NULL as not-declined: 14-day window applies, never the 60-day one.
  { key: "legacy-fresh", phone: "+59893000007", contact: 5, outcome: null, shown: false },
  { key: "legacy-old", phone: "+59893000008", contact: 20, outcome: null, shown: true },
] as const;

let service: SupabaseClient;

beforeAll(async () => {
  const { url, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);

  const { data: clients, error: cErr } = await service
    .from("clients")
    .insert(
      CASES.map((c) => ({
        full_name: `Loop ${c.key}`,
        phone: c.phone,
        last_reactivation_at: c.contact === null ? null : daysAgo(c.contact),
        reactivation_outcome: c.outcome,
      })),
      { defaultToNull: false },
    )
    .select("id, phone");
  if (cErr) throw new Error(`client seed failed: ${cErr.message}`);
  const idByPhone = Object.fromEntries(clients!.map((c) => [c.phone, c.id]));

  const { error: sErr } = await service.from("sessions").insert(
    CASES.map((c) => ({
      gcal_event_id: `${PREFIX}${c.key}`,
      client_id: idByPhone[c.phone],
      starts_at: daysAgo(30),
    })),
    { defaultToNull: false },
  );
  if (sErr) throw new Error(`session seed failed: ${sErr.message}`);
});

afterAll(async () => {
  await service.from("sessions").delete().like("gcal_event_id", `${PREFIX}%`);
  await service
    .from("clients")
    .delete()
    .in("phone", CASES.map((c) => c.phone));
});

describe("v_reactivation loop filters (issue #53)", () => {
  it("hides fresh contacts and declined-within-60d; shows the rest", async () => {
    const { data, error } = await service
      .from("v_reactivation")
      .select("phone")
      .in("phone", CASES.map((c) => c.phone));
    expect(error).toBeNull();
    const shownPhones = new Set(data!.map((r) => r.phone));
    for (const c of CASES) {
      expect(shownPhones.has(c.phone), c.key).toBe(c.shown);
    }
  });
});

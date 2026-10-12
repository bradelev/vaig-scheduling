/**
 * Dismissed sessions are excluded from v_unmatched (issue #48). CI-only;
 * filters on its own seed rows. All personal data invented.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";

const PREFIX = "evt-dismiss-";
let service: SupabaseClient;

beforeAll(async () => {
  const { url, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);
  const { error } = await service.from("sessions").insert(
    [
      {
        gcal_event_id: `${PREFIX}queued`,
        starts_at: new Date(Date.now() + 86_400_000).toISOString(),
        raw_title: "clienta inventada 15hs",
      },
      {
        gcal_event_id: `${PREFIX}dismissed`,
        starts_at: new Date(Date.now() + 86_400_000).toISOString(),
        raw_title: "factura inventada vence el 10",
        dismissed_at: new Date().toISOString(),
      },
    ],
    { defaultToNull: false },
  );
  if (error) throw new Error(`seed failed: ${error.message}`);
});

afterAll(async () => {
  await service.from("sessions").delete().like("gcal_event_id", `${PREFIX}%`);
});

describe("v_unmatched vs dismissed (issue #48)", () => {
  it("shows the queued row and hides the dismissed one", async () => {
    const { data, error } = await service
      .from("v_unmatched")
      .select("gcal_event_id")
      .like("gcal_event_id", `${PREFIX}%`);
    expect(error).toBeNull();
    expect(data!.map((r) => r.gcal_event_id)).toEqual([`${PREFIX}queued`]);
  });

  it("a dismissed row cannot be resolved (the R1 guard matches 0 rows)", async () => {
    // Replicates resolveSession's guarded update: a concurrently-dismissed
    // row must never become someone's session (it would surface in
    // v_client_status and could fire a reminder).
    const { data, error } = await service
      .from("sessions")
      .update({ match_method: "manual" })
      .eq("gcal_event_id", `${PREFIX}dismissed`)
      .is("client_id", null)
      .is("dismissed_at", null)
      .select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]); // guard filtered it out
  });
});

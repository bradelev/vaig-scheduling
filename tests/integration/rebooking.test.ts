/**
 * v_rebooking_past (issue #107): each matched, non-cancelled past session in
 * the 60-day window carries has_later = does the client have any later
 * non-cancelled session. CI-only; filters on its own seed rows. All
 * personal data invented.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";

const PREFIX = "evt-rebook-";
let service: SupabaseClient;
let clientId: string;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

beforeAll(async () => {
  const { url, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);

  const { data: client, error: cErr } = await service
    .from("clients")
    .insert({ full_name: "Rebook Inventada", phone: "+59891230107" })
    .select("id")
    .single();
  if (cErr) throw new Error(`client seed: ${cErr.message}`);
  clientId = client.id;

  const { error } = await service.from("sessions").insert(
    [
      // Attended 20 days ago, followed by a later session → has_later true.
      {
        gcal_event_id: `${PREFIX}old`,
        client_id: clientId,
        starts_at: daysAgo(20),
        raw_title: "rebook vieja",
      },
      // Attended 5 days ago, nothing after → has_later false.
      {
        gcal_event_id: `${PREFIX}recent`,
        client_id: clientId,
        starts_at: daysAgo(5),
        raw_title: "rebook reciente",
      },
      // A cancelled later session must NOT count as a rebooking.
      {
        gcal_event_id: `${PREFIX}cancelled-future`,
        client_id: clientId,
        starts_at: daysAgo(-3),
        raw_title: "rebook cancelada",
        status: "cancelled",
      },
      // Outside the 60-day window → not in the view at all.
      {
        gcal_event_id: `${PREFIX}ancient`,
        client_id: clientId,
        starts_at: daysAgo(90),
        raw_title: "rebook antigua",
      },
    ],
    { defaultToNull: false },
  );
  if (error) throw new Error(`session seed: ${error.message}`);
});

afterAll(async () => {
  await service.from("sessions").delete().like("gcal_event_id", `${PREFIX}%`);
  await service.from("clients").delete().eq("id", clientId);
});

describe("v_rebooking_past (issue #107)", () => {
  it("flags has_later correctly and honors the 60-day window", async () => {
    const { data, error } = await service
      .from("v_rebooking_past")
      .select("starts_at, has_later")
      .eq("client_id", clientId)
      .order("starts_at");
    expect(error).toBeNull();
    const rows = data!;
    // The 90-day-old session is out of the window; the two in-window ones remain.
    expect(rows).toHaveLength(2);
    // Oldest first: the 20-day-ago session was followed by the 5-day-ago one
    // on a later Montevideo day → rebooked.
    expect(rows[0].has_later).toBe(true);
    // The 5-day-ago session has only a CANCELLED later one → not counted.
    expect(rows[1].has_later).toBe(false);
  });
});

/**
 * Self-heal guard chain (issue #84): the sync's dismissDiscarded adapter
 * dismisses ONLY unmatched, not-yet-dismissed rows — a matched session must
 * survive its event turning into a chore. CI-only; mirrors the exact chain
 * in supabase/functions/sync-calendar/index.ts (KEEP THEM IN SYNC) and
 * filters on its own seed rows. All personal data invented.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";

const PREFIX = "evt-selfheal-";
let service: SupabaseClient;
let matchedClientId: string;

beforeAll(async () => {
  const { url, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);

  const { data: client, error: cErr } = await service
    .from("clients")
    .insert({ full_name: "Selfheal Inventada", phone: "+59891230084" })
    .select("id")
    .single();
  if (cErr) throw new Error(`client seed failed: ${cErr.message}`);
  matchedClientId = client.id;

  const { error } = await service.from("sessions").insert(
    [
      {
        gcal_event_id: `${PREFIX}leftover`,
        starts_at: new Date(Date.now() + 86_400_000).toISOString(),
        raw_title: "vence factura inventada",
      },
      {
        gcal_event_id: `${PREFIX}matched`,
        starts_at: new Date(Date.now() + 86_400_000).toISOString(),
        raw_title: "vence factura inventada 2",
        client_id: matchedClientId,
        match_method: "manual",
      },
      {
        gcal_event_id: `${PREFIX}already`,
        starts_at: new Date(Date.now() + 86_400_000).toISOString(),
        raw_title: "vence factura inventada 3",
        dismissed_at: new Date().toISOString(),
      },
    ],
    { defaultToNull: false },
  );
  if (error) throw new Error(`seed failed: ${error.message}`);
});

afterAll(async () => {
  await service.from("sessions").delete().like("gcal_event_id", `${PREFIX}%`);
  await service.from("clients").delete().eq("id", matchedClientId);
});

describe("sync self-heal guards (issue #84)", () => {
  it("dismisses only the unmatched, not-yet-dismissed leftover", async () => {
    const ids = [
      `${PREFIX}leftover`,
      `${PREFIX}matched`,
      `${PREFIX}already`,
      `${PREFIX}never-existed`,
    ];
    // KEEP THE FILTER CHAIN IN SYNC with dismissDiscarded in
    // supabase/functions/sync-calendar/index.ts.
    const { data, error } = await service
      .from("sessions")
      .update({ dismissed_at: new Date().toISOString() })
      .in("gcal_event_id", ids)
      .is("client_id", null)
      .is("dismissed_at", null)
      .select("gcal_event_id");
    expect(error).toBeNull();
    expect(data!.map((r) => r.gcal_event_id)).toEqual([`${PREFIX}leftover`]);
  });

  it("the matched session is untouched and still visible to its client", async () => {
    const { data, error } = await service
      .from("sessions")
      .select("dismissed_at")
      .eq("gcal_event_id", `${PREFIX}matched`)
      .single();
    expect(error).toBeNull();
    expect(data!.dismissed_at).toBeNull();
  });
});

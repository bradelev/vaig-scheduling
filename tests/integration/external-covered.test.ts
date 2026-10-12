/**
 * v_client_status.next_external_covered (issue #89) and next2_session_at
 * (issue #92): the SQL must key on the
 * MONTEVIDEO calendar day — a external booking at 02:00Z shares the local day
 * with a manual session the previous UTC date. CI-only; filters on its own
 * seed rows. All personal data invented.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";

const PREFIX = "evt-koocov-";
let service: SupabaseClient;
const clientIds: string[] = [];

/** A timestamptz N days ahead at the given UTC hour, ISO. */
function ahead(days: number, hourUtc: number, minute = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d.toISOString();
}

async function seedClient(name: string, phone: string): Promise<string> {
  const { data, error } = await service
    .from("clients")
    .insert({ full_name: name, phone })
    .select("id")
    .single();
  if (error) throw new Error(`client seed: ${error.message}`);
  clientIds.push(data.id);
  return data.id;
}

beforeAll(async () => {
  const { url, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);

  // Twin case across the UTC boundary: manual next session at 23:00 MVD
  // (02:00Z next UTC day) + scheduled external booking at 14:00 MVD the SAME
  // local day → covered, even though UTC dates differ.
  const twin = await seedClient("Koocov Twin Inventada", "+59891230089");
  // Cancelled-external case: same local day but cancelled → NOT covered.
  const cancelled = await seedClient("Koocov Cancel Inventada", "+59891230090");
  // Manual-only case: no external anywhere → NOT covered.
  const manualOnly = await seedClient("Koocov Manual Inventada", "+59891230091");

  const { error } = await service.from("sessions").insert(
    [
      {
        gcal_event_id: `${PREFIX}twin-manual`,
        client_id: twin,
        starts_at: ahead(3, 2, 0), // 23:00 MVD on day+2 local
        raw_title: "koocov twin manual",
        source: "manual",
      },
      {
        gcal_event_id: `${PREFIX}twin-external`,
        client_id: twin,
        starts_at: ahead(2, 17, 0), // 14:00 MVD same local day (day+2)
        raw_title: "External - Cita con koocov twin",
        source: "external",
      },
      {
        gcal_event_id: `${PREFIX}cancel-manual`,
        client_id: cancelled,
        starts_at: ahead(2, 15, 0),
        raw_title: "koocov cancel manual",
        source: "manual",
      },
      {
        gcal_event_id: `${PREFIX}cancel-external`,
        client_id: cancelled,
        starts_at: ahead(2, 17, 30),
        raw_title: "External - Cita con koocov cancel",
        source: "external",
        status: "cancelled",
      },
      {
        gcal_event_id: `${PREFIX}manual-only`,
        client_id: manualOnly,
        starts_at: ahead(2, 15, 0),
        raw_title: "koocov manual only",
        source: "manual",
      },
      {
        gcal_event_id: `${PREFIX}manual-later`,
        client_id: manualOnly,
        starts_at: ahead(9, 15, 0),
        raw_title: "koocov manual later",
        source: "manual",
      },
    ],
    { defaultToNull: false },
  );
  if (error) throw new Error(`session seed: ${error.message}`);
});

afterAll(async () => {
  await service.from("sessions").delete().like("gcal_event_id", `${PREFIX}%`);
  for (const id of clientIds) {
    await service.from("clients").delete().eq("id", id);
  }
});

describe("v_client_status.next_external_covered (issue #89)", () => {
  async function rowFor(name: string) {
    const { data, error } = await service
      .from("v_client_status")
      .select("full_name, next_source, next_external_covered")
      .eq("full_name", name)
      .single();
    expect(error).toBeNull();
    return data!;
  }

  it("covers the manual twin across the UTC midnight boundary", async () => {
    const row = await rowFor("Koocov Twin Inventada");
    expect(row.next_source).toBe("external"); // 14:00 MVD comes first
    expect(row.next_external_covered).toBe(true);
  });

  it("a cancelled external booking covers nothing", async () => {
    const row = await rowFor("Koocov Cancel Inventada");
    expect(row.next_source).toBe("manual");
    expect(row.next_external_covered).toBe(false);
  });

  it("manual-only clients are not covered", async () => {
    const row = await rowFor("Koocov Manual Inventada");
    expect(row.next_external_covered).toBe(false);
  });
});

describe("v_client_status.next2_session_at (issue #92)", () => {
  it("a same-local-day twin is NOT next2 (nothing after -> null)", async () => {
    const { data, error } = await service
      .from("v_client_status")
      .select("next2_session_at")
      .eq("full_name", "Koocov Twin Inventada")
      .single();
    expect(error).toBeNull();
    // next = external 14:00 MVD; the 23:00 MVD manual twin shares the local
    // day (even though its UTC date is the next one) and must be skipped.
    expect(data!.next2_session_at).toBeNull();
  });

  it("a booking on a later day IS next2", async () => {
    const { data, error } = await service
      .from("v_client_status")
      .select("next2_session_at")
      .eq("full_name", "Koocov Manual Inventada")
      .single();
    expect(error).toBeNull();
    expect(data!.next2_session_at).not.toBeNull();
  });
});

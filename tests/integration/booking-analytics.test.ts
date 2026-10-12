/**
 * Booking analytics integration test (CI-only): migration booking_analytics —
 * the event tables' RLS posture, the booking_metrics aggregates, and the
 * one-row-per-phone recovery queue semantics. All data invented.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";

const PHONE = "+59891660011";
const ITEM_NAME = "Analytics probe item";
const K1 = "11111111-1111-4111-8111-111111111111";
const K2 = "22222222-2222-4222-8222-222222222222";

let service: SupabaseClient;
let anon: SupabaseClient;
let itemId: string;
let clientId: string;

beforeAll(async () => {
  const { url, anonKey, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);
  anon = createClient(url, anonKey, clientOptions);
  const item = await service
    .from("booking_services")
    .insert({ name: ITEM_NAME, category: "Depilación Láser", duration_min: 30, active: true })
    .select("id")
    .single();
  if (item.error) throw new Error(`item seed: ${item.error.message}`);
  itemId = item.data.id;
  const client = await service
    .from("clients")
    .insert({ full_name: "Analytics Probe", phone: PHONE })
    .select("id")
    .single();
  if (client.error) throw new Error(`client seed: ${client.error.message}`);
  clientId = client.data.id;
});

afterAll(async () => {
  await service.from("booking_events").delete().in("session_key", [K1, K2]);
  await service.from("panel_events").delete().eq("route", "/metricas");
  await service.from("booking_recovery").delete().eq("phone", PHONE);
  await service.from("clients").delete().eq("phone", PHONE);
  await service.from("booking_services").delete().eq("id", itemId);
});

describe("booking_events + booking_metrics", () => {
  it("aggregates distinct sessions per step and unmet demand per service/week", async () => {
    const rows = [
      { session_key: K1, event: "page_view" },
      { session_key: K1, event: "service_selected", booking_service_id: itemId },
      { session_key: K1, event: "no_slots_seen", booking_service_id: itemId, week_key: "2026-09-14" },
      { session_key: K1, event: "no_slots_seen", booking_service_id: itemId, week_key: "2026-09-14" },
      { session_key: K2, event: "page_view" },
      // The same session twice must count ONCE in the funnel.
      { session_key: K2, event: "page_view" },
      { session_key: K2, event: "service_selected", booking_service_id: itemId },
      { session_key: K2, event: "reserve_ok", booking_service_id: itemId },
    ];
    const ins = await service.from("booking_events").insert(rows);
    expect(ins.error).toBeNull();
    await service.from("panel_events").insert({ route: "/metricas" });

    const { data, error } = await service.rpc("booking_metrics", { p_days: 7 });
    expect(error).toBeNull();
    const m = data as {
      funnel: Record<string, number>;
      no_slots: { name: string; week_key: string; times: number }[];
      per_service: { name: string; viewed: number; booked: number }[];
      panel_usage: Record<string, number>;
    };
    expect(m.funnel.page_view).toBe(2); // distinct sessions, not raw rows
    expect(m.funnel.service_selected).toBe(2);
    expect(m.funnel.reserve_ok).toBe(1);
    const probeNoSlots = m.no_slots.find((r) => r.name === ITEM_NAME);
    expect(probeNoSlots).toMatchObject({ times: 2, week_key: "2026-09-14" });
    const probeSvc = m.per_service.find((r) => r.name === ITEM_NAME);
    expect(probeSvc).toMatchObject({ viewed: 2, booked: 1 });
    expect(m.panel_usage["/metricas"]).toBeGreaterThanOrEqual(1);
  });

  it("anon can neither write events nor run the aggregate", async () => {
    const ins = await anon.from("booking_events").insert({ session_key: K1, event: "page_view" });
    expect(ins.error?.code).toBe("42501");
    const rpc = await anon.rpc("booking_metrics", { p_days: 7 });
    expect(rpc.error?.code).toBe("42501");
  });
});

describe("booking_recovery", () => {
  it("one row per phone: the latest intent wins and re-opens a contacted row", async () => {
    const first = await service.from("booking_recovery").upsert(
      { phone: PHONE, client_id: clientId, booking_service_id: itemId, slot_at: "2026-09-20T14:00:00Z" },
      { onConflict: "phone" },
    );
    expect(first.error).toBeNull();
    await service
      .from("booking_recovery")
      .update({ contacted_at: new Date().toISOString() })
      .eq("phone", PHONE);

    const again = await service.from("booking_recovery").upsert(
      {
        phone: PHONE,
        client_id: clientId,
        booking_service_id: itemId,
        slot_at: "2026-09-21T15:00:00Z",
        updated_at: new Date().toISOString(),
        contacted_at: null,
      },
      { onConflict: "phone" },
    );
    expect(again.error).toBeNull();

    const rows = await service.from("booking_recovery").select("slot_at, contacted_at").eq("phone", PHONE);
    expect(rows.data).toHaveLength(1);
    expect(rows.data?.[0]).toMatchObject({ contacted_at: null });
    expect(rows.data?.[0]?.slot_at).toContain("2026-09-21");
  });

  it("anon sees nothing in the recovery queue", async () => {
    const res = await anon.from("booking_recovery").select("phone");
    // Depending on grants this is either a permission error or an empty set —
    // both mean anon reads nothing.
    if (res.error) {
      expect(res.error.code).toBe("42501");
    } else {
      expect(res.data).toEqual([]);
    }
  });
});

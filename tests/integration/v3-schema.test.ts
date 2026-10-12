/**
 * v3 schema foundation (PRD Part II §II.2/§II.4/§II.6/§II.7, issue #115).
 * CI-only: validates the migration against a live stack — the SQL-level
 * facts `npm run check` cannot verify locally (no Docker). All personal data
 * invented with a real format (+59891234567). Cleans up its own seed rows.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";

const PREFIX = "evt-v3schema-";
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();
let service: SupabaseClient;
let clientId: string;

beforeAll(async () => {
  const { url, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);

  // An invented client to attach app-origin sessions to.
  const { data, error } = await service
    .from("clients")
    .insert({ full_name: "Alba Inventada", phone: "+59891230001" })
    .select("id")
    .single();
  if (error) throw new Error(`seed client failed: ${error.message}`);
  clientId = data!.id;
});

afterAll(async () => {
  await service.from("sessions").delete().like("gcal_event_id", `${PREFIX}%`);
  // App-origin rows have NULL gcal_event_id — delete them by client, then the client.
  if (clientId) {
    await service.from("sessions").delete().eq("client_id", clientId);
    await service.from("clients").delete().eq("id", clientId);
  }
});

describe("v3 session schema (issue #115)", () => {
  it("accepts an app-origin session with NO gcal_event_id (mirror not written yet)", async () => {
    const { data, error } = await service
      .from("sessions")
      .insert({
        source: "app",
        client_id: clientId,
        starts_at: tomorrow(),
        service: "hifu",
        note: "primera consulta, viene con una amiga",
      })
      .select("id, gcal_event_id, source, note")
      .single();
    expect(error).toBeNull();
    expect(data!.gcal_event_id).toBeNull();
    expect(data!.source).toBe("app");
    expect(data!.note).toBe("primera consulta, viene con una amiga");
  });

  it("rejects an app-origin session WITHOUT a client_id (identity CHECK)", async () => {
    const { error } = await service.from("sessions").insert({
      source: "app",
      client_id: null,
      starts_at: tomorrow(),
    });
    expect(error).not.toBeNull(); // sessions_app_needs_client violated
  });

  it("still allows a external/manual row with NULL client_id (cascade unchanged)", async () => {
    const { error } = await service.from("sessions").insert({
      gcal_event_id: `${PREFIX}external`,
      source: "external",
      client_id: null,
      starts_at: tomorrow(),
      raw_title: "External - Cita con Alba Inventada",
    });
    expect(error).toBeNull();
  });

  it("enforces uniqueness of gcal_event_id but allows many NULLs (plain unique, NULLS DISTINCT)", async () => {
    // Two app rows with NULL gcal must coexist (the old NOT NULL UNIQUE blocked this).
    const rows = [
      { source: "app", client_id: clientId, starts_at: tomorrow(), service: "botox" },
      { source: "app", client_id: clientId, starts_at: tomorrow(), service: "masaje" },
    ];
    const { error } = await service.from("sessions").insert(rows);
    expect(error).toBeNull();
  });

  it("rejects a duplicate NON-null gcal_event_id (uniqueness still holds)", async () => {
    const gid = `${PREFIX}dup`;
    const first = await service.from("sessions").insert({
      gcal_event_id: gid,
      source: "manual",
      starts_at: tomorrow(),
    });
    expect(first.error).toBeNull();
    const second = await service.from("sessions").insert({
      gcal_event_id: gid,
      source: "manual",
      starts_at: tomorrow(),
    });
    expect(second.error).not.toBeNull(); // partial unique index rejects the dup
  });

  it("rejects an APP session whose service is not a known category (trigger)", async () => {
    const { error } = await service.from("sessions").insert({
      source: "app",
      client_id: clientId,
      starts_at: tomorrow(),
      service: "no_existe_esta_categoria",
    });
    expect(error).not.toBeNull(); // validate_app_service trigger
  });

  it("ALLOWS a external/manual session with a free-text service NOT in the catalog", async () => {
    // The category catalog is enforced only for source='app'. External/manual
    // rows carry legacy free-text services (e.g. "maderoterapia") and must not
    // be rejected — this is the regression that broke views.test.ts.
    const { error } = await service.from("sessions").insert({
      gcal_event_id: `${PREFIX}freetext-service`,
      source: "manual",
      starts_at: tomorrow(),
      service: "maderoterapia",
    });
    expect(error).toBeNull();
  });

  it("has the seeded service-category catalog", async () => {
    const { data, error } = await service
      .from("service_types")
      .select("slug")
      .in("slug", ["depilacion", "hifu", "botox", "radiofrecuencia"]);
    expect(error).toBeNull();
    expect(data!.length).toBe(4);
  });

  it("supports the sync's onConflict:\"gcal_event_id\" upsert (regression: partial index breaks this)", async () => {
    // Mirrors sync-calendar/index.ts:140 exactly. A PARTIAL unique index on
    // gcal_event_id cannot back ON CONFLICT inference and would throw
    // "no unique or exclusion constraint matching the ON CONFLICT
    // specification" on every hourly sync. This test guards that regression.
    const gid = `${PREFIX}upsert`;
    const first = await service
      .from("sessions")
      .upsert(
        { gcal_event_id: gid, source: "external", starts_at: tomorrow() },
        { onConflict: "gcal_event_id" },
      );
    expect(first.error).toBeNull();
    // Second upsert on the same gcal id must UPDATE, not error or duplicate.
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const second = await service
      .from("sessions")
      .upsert(
        { gcal_event_id: gid, source: "external", starts_at: later },
        { onConflict: "gcal_event_id" },
      );
    expect(second.error).toBeNull();
    const { data } = await service
      .from("sessions")
      .select("id, starts_at")
      .eq("gcal_event_id", gid);
    expect(data!.length).toBe(1); // updated in place, not duplicated
  });

  it("stores divergence columns orthogonal to status (§II.6)", async () => {
    const proposed = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const now = new Date().toISOString();
    const { data, error } = await service
      .from("sessions")
      .insert({
        source: "app",
        client_id: clientId,
        starts_at: tomorrow(),
        status: "scheduled",
        divergence_detected_at: now,
        proposed_starts_at: proposed,
      })
      .select("status, divergence_detected_at, proposed_starts_at")
      .single();
    expect(error).toBeNull();
    // A scheduled session can also carry a divergence — the two are orthogonal.
    expect(data!.status).toBe("scheduled");
    expect(data!.divergence_detected_at).not.toBeNull();
    expect(data!.proposed_starts_at).not.toBeNull();
  });

  it("bumps updated_at on UPDATE (set_updated_at trigger, TECH_DEBT 2026-07-17)", async () => {
    const inserted = await service
      .from("sessions")
      .insert({
        gcal_event_id: `${PREFIX}touch`,
        source: "manual",
        starts_at: tomorrow(),
      })
      .select("id, updated_at")
      .single();
    expect(inserted.error).toBeNull();
    const before = inserted.data!.updated_at as string;

    const updated = await service
      .from("sessions")
      .update({ status: "cancelled" })
      .eq("id", inserted.data!.id)
      .select("updated_at")
      .single();
    expect(updated.error).toBeNull();
    expect(new Date(updated.data!.updated_at).getTime()).toBeGreaterThan(
      new Date(before).getTime(),
    );
  });

  it("marks a client as first-visit (flag stored, not derived)", async () => {
    const { data, error } = await service
      .from("clients")
      .insert({
        full_name: "Bruno Inventado",
        phone: "+59891230002",
        is_first_visit: true,
      })
      .select("id, is_first_visit")
      .single();
    expect(error).toBeNull();
    expect(data!.is_first_visit).toBe(true);
    await service.from("clients").delete().eq("id", data!.id);
  });
});

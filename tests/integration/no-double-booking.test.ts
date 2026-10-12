/**
 * Exclusion-constraint integration test (Phase 2, CI-only): the DB guard against
 * two sessions for the SAME professional overlapping in time. This is the whole
 * point of migration 20260828044934, and data integrity is the sensitive part —
 * so it must be exercised against a real stack, not just reasoned about.
 *
 * All data invented (fixture E.164 / invented staff id). Seeds as service_role.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";

const STAFF = "iara"; // a seeded staff id
const OTHER_STAFF = "lu";
const EVT = "evt-nodouble-";

let service: SupabaseClient;
let clientId: string;

async function insertSession(row: {
  gcal: string;
  attendedBy: string | null;
  start: string;
  end: string | null;
  status?: string;
}) {
  return service.from("sessions").insert({
    gcal_event_id: row.gcal,
    client_id: clientId,
    source: "app",
    attended_by: row.attendedBy,
    starts_at: row.start,
    ends_at: row.end,
    status: row.status ?? "scheduled",
  });
}

beforeAll(async () => {
  const { url, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);
  const seed = await service
    .from("clients")
    .insert({ full_name: "NoDouble Probe", phone: "+59891778899" })
    .select("id")
    .single();
  if (seed.error) throw new Error(`seed failed: ${seed.error.message}`);
  clientId = seed.data.id;
});

afterAll(async () => {
  await service.from("sessions").delete().like("gcal_event_id", `${EVT}%`);
  await service.from("clients").delete().eq("phone", "+59891778899");
});

describe("sessions_no_overlap exclusion constraint", () => {
  it("rejects a second session overlapping the same professional", async () => {
    const a = await insertSession({
      gcal: `${EVT}a`,
      attendedBy: STAFF,
      start: "2026-09-10T14:00:00Z",
      end: "2026-09-10T15:00:00Z",
    });
    expect(a.error).toBeNull();
    // Overlaps 14:00-15:00 (starts 14:30) → rejected.
    const b = await insertSession({
      gcal: `${EVT}b`,
      attendedBy: STAFF,
      start: "2026-09-10T14:30:00Z",
      end: "2026-09-10T15:30:00Z",
    });
    expect(b.error).not.toBeNull();
    expect(b.error?.message).toMatch(/exclusion|overlap|sessions_no_overlap/i);
  });

  it("allows a back-to-back session (touching, not overlapping)", async () => {
    // 15:00-16:00 starts exactly when the 14:00-15:00 above ends → '[)' allows it.
    const c = await insertSession({
      gcal: `${EVT}c`,
      attendedBy: STAFF,
      start: "2026-09-10T15:00:00Z",
      end: "2026-09-10T16:00:00Z",
    });
    expect(c.error).toBeNull();
  });

  it("allows the same time for a DIFFERENT professional", async () => {
    const d = await insertSession({
      gcal: `${EVT}d`,
      attendedBy: OTHER_STAFF,
      start: "2026-09-10T14:00:00Z",
      end: "2026-09-10T15:00:00Z",
    });
    expect(d.error).toBeNull();
  });

  it("treats a NULL ends_at as 60 min busy (rejects a 30-min-later overlap)", async () => {
    const e = await insertSession({
      gcal: `${EVT}e`,
      attendedBy: STAFF,
      start: "2026-09-11T10:00:00Z",
      end: null, // → occupies 10:00-11:00 via the coalesce-60 range
    });
    expect(e.error).toBeNull();
    const f = await insertSession({
      gcal: `${EVT}f`,
      attendedBy: STAFF,
      start: "2026-09-11T10:30:00Z", // inside the 10:00-11:00 fallback window
      end: "2026-09-11T11:30:00Z",
    });
    expect(f.error).not.toBeNull();
  });

  it("does NOT constrain unassigned (null attended_by) sessions", async () => {
    // Two overlapping rows with no professional assigned — both allowed.
    const g = await insertSession({
      gcal: `${EVT}g`,
      attendedBy: null,
      start: "2026-09-12T09:00:00Z",
      end: "2026-09-12T10:00:00Z",
    });
    const h = await insertSession({
      gcal: `${EVT}h`,
      attendedBy: null,
      start: "2026-09-12T09:30:00Z",
      end: "2026-09-12T10:30:00Z",
    });
    expect(g.error).toBeNull();
    expect(h.error).toBeNull();
  });

  it("a cancelled session frees its slot (overlap with it is allowed)", async () => {
    const i = await insertSession({
      gcal: `${EVT}i`,
      attendedBy: STAFF,
      start: "2026-09-13T12:00:00Z",
      end: "2026-09-13T13:00:00Z",
      status: "cancelled",
    });
    expect(i.error).toBeNull();
    // Overlaps the cancelled one → allowed (cancelled is outside the WHERE).
    const j = await insertSession({
      gcal: `${EVT}j`,
      attendedBy: STAFF,
      start: "2026-09-13T12:30:00Z",
      end: "2026-09-13T13:30:00Z",
    });
    expect(j.error).toBeNull();
  });
});

// Invented data only.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the service-role client with a minimal chainable builder (same pattern
// as lib/sessions/actions.test.ts): every call is recorded and returns the
// builder; the queued result resolves via .single()/.maybeSingle()/await.
type QueryResult = { data: unknown; error: { code?: string; message: string } | null; count?: number | null };
type Call = { method: string; args: unknown[] };
let resultQueue: Record<string, QueryResult[]>;
let callsByTable: Record<string, Call[][]>;

function makeBuilder(result: QueryResult, calls: Call[]) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "delete", "eq", "gte", "is", "neq"]) {
    b[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return b;
    };
  }
  b.single = () => Promise.resolve(result);
  b.maybeSingle = () => Promise.resolve(result);
  b.then = (res: (v: QueryResult) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return b;
}
function queue(table: string, r: QueryResult) {
  (resultQueue[table] ??= []).push(r);
}
function callsFor(table: string, i = 0): Call[] {
  return callsByTable[table]?.[i] ?? [];
}

vi.mock("../supabase/service", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const result = resultQueue[table]?.shift() ?? { data: null, error: null };
      const calls: Call[] = [];
      (callsByTable[table] ??= []).push(calls);
      return makeBuilder(result, calls);
    },
    // RPCs are keyed "rpc:<name>"; the args are recorded as a call.
    rpc: (name: string, args: unknown) => {
      const key = `rpc:${name}`;
      const result = resultQueue[key]?.shift() ?? { data: null, error: null };
      (callsByTable[key] ??= []).push([{ method: "rpc", args: [args] }]);
      return Promise.resolve(result);
    },
  }),
}));

const getServiceAvailability = vi.fn();
vi.mock("./service-availability", () => ({
  getServiceAvailability: (...a: unknown[]) => getServiceAvailability(...a),
}));
vi.mock("./notify-staff", () => ({ notifyNewReservation: vi.fn() }));

import { clientNameByPhone, isExclusionViolation, makeReservePorts, PLACEHOLDER_CLIENT_NAME } from "./reserve-ports";
import { serviceClient } from "../supabase/service";
import { verifiedPhone } from "./reserve";

const PHONE = verifiedPhone("+59891234567");
const NOW = Date.parse("2026-09-01T12:00:00Z");

beforeEach(() => {
  resultQueue = {};
  callsByTable = {};
  getServiceAvailability.mockReset();
});

describe("clientForPhone", () => {
  it("returns an existing client with their name and never inserts", async () => {
    queue("clients", { data: { id: "c1", full_name: "Ana Prueba" }, error: null });
    const res = await makeReservePorts({ nowMs: NOW }).clientForPhone(PHONE, "Otro Nombre");
    expect(res).toEqual({ id: "c1", name: "Ana Prueba" });
    expect(callsFor("clients", 0).some((c) => c.method === "insert")).toBe(false);
    expect(callsByTable.clients).toHaveLength(1); // no second query, no update
  });

  it("reports the placeholder name as null so the notice says 'una clienta'", async () => {
    queue("clients", { data: { id: "c1", full_name: PLACEHOLDER_CLIENT_NAME }, error: null });
    const res = await makeReservePorts({ nowMs: NOW }).clientForPhone(PHONE, null);
    expect(res).toEqual({ id: "c1", name: null });
  });

  it("creates a missing client with the given name (or the placeholder)", async () => {
    queue("clients", { data: null, error: null }); // not found
    queue("clients", { data: { id: "c2" }, error: null }); // insert
    const res = await makeReservePorts({ nowMs: NOW }).clientForPhone(PHONE, "Ana Prueba");
    expect(res).toEqual({ id: "c2", name: "Ana Prueba" });
    expect(callsFor("clients", 1)).toContainEqual({
      method: "insert",
      args: [{ full_name: "Ana Prueba", phone: PHONE }],
    });

    resultQueue = {};
    callsByTable = {};
    queue("clients", { data: null, error: null });
    queue("clients", { data: { id: "c3" }, error: null });
    const res2 = await makeReservePorts({ nowMs: NOW }).clientForPhone(PHONE, null);
    expect(res2).toEqual({ id: "c3", name: null });
    expect(callsFor("clients", 1)).toContainEqual({
      method: "insert",
      args: [{ full_name: PLACEHOLDER_CLIENT_NAME, phone: PHONE }],
    });
  });

  it("on a unique-violation race (23505) re-selects the row the other insert made", async () => {
    queue("clients", { data: null, error: null }); // not found
    queue("clients", { data: null, error: { code: "23505", message: "duplicate key" } }); // lost the race
    queue("clients", { data: { id: "c9", full_name: "Ana Prueba" }, error: null }); // re-select
    const res = await makeReservePorts({ nowMs: NOW }).clientForPhone(PHONE, "Ana Prueba");
    expect(res).toEqual({ id: "c9", name: "Ana Prueba" });
  });

  it("any other insert error propagates", async () => {
    queue("clients", { data: null, error: null });
    queue("clients", { data: null, error: { code: "42501", message: "permission denied" } });
    await expect(
      makeReservePorts({ nowMs: NOW }).clientForPhone(PHONE, null),
    ).rejects.toThrow("permission denied");
  });
});

describe("pendingReservationCount", () => {
  it("counts future pending scheduled sessions of the client", async () => {
    queue("sessions", { data: null, error: null, count: 2 });
    const n = await makeReservePorts({ nowMs: NOW }).pendingReservationCount("c1");
    expect(n).toBe(2);
    const calls = callsFor("sessions", 0);
    expect(calls).toContainEqual({ method: "eq", args: ["client_id", "c1"] });
    expect(calls).toContainEqual({ method: "eq", args: ["pending_confirmation", true] });
    expect(calls).toContainEqual({ method: "eq", args: ["status", "scheduled"] });
    expect(calls).toContainEqual({ method: "gte", args: ["starts_at", new Date(NOW).toISOString()] });
  });

  it("a null count is 0; a read error propagates", async () => {
    queue("sessions", { data: null, error: null, count: null });
    expect(await makeReservePorts({ nowMs: NOW }).pendingReservationCount("c1")).toBe(0);
    queue("sessions", { data: null, error: { message: "boom" } });
    await expect(makeReservePorts({ nowMs: NOW }).pendingReservationCount("c1")).rejects.toThrow("boom");
  });
});

describe("serviceAvailability", () => {
  it("not_found → null (the client's problem)", async () => {
    getServiceAvailability.mockResolvedValue({ error: "Service unavailable.", kind: "not_found" });
    expect(await makeReservePorts({ nowMs: NOW }).serviceAvailability("svc", "2026-09-04")).toBeNull();
  });

  it("read_failed → throws (ours — never reported as an invalid service)", async () => {
    getServiceAvailability.mockResolvedValue({ error: "Could not read the service: down", kind: "read_failed" });
    await expect(
      makeReservePorts({ nowMs: NOW }).serviceAvailability("svc", "2026-09-04"),
    ).rejects.toThrow("down");
  });

  it("passes nowMs through and flattens the service", async () => {
    getServiceAvailability.mockResolvedValue({
      service: { name: "Pierna entera", category: "Depilación Láser", durationMin: 60 },
      candidates: [],
      anySlots: [],
    });
    const res = await makeReservePorts({ nowMs: NOW }).serviceAvailability("svc", "2026-09-04");
    expect(res).toEqual({ name: "Pierna entera", category: "Depilación Láser", durationMin: 60, candidates: [] });
    expect(getServiceAvailability).toHaveBeenCalledWith(expect.anything(), {
      serviceId: "svc",
      dayKey: "2026-09-04",
      nowMs: NOW,
    });
  });
});

describe("package ports (cuponera)", () => {
  it("takePackageCredit calls the serialized consume-or-create RPC and maps the row", async () => {
    queue("rpc:take_package_credit", {
      data: [{ id: "pkg-1", total_sessions: 6, used_sessions: 3, created: false }],
      error: null,
    });
    const ports = makeReservePorts({ nowMs: NOW });
    expect(await ports.takePackageCredit("c1", "svc", 6)).toEqual({ id: "pkg-1", total: 6, used: 3, created: false });
    expect(callsFor("rpc:take_package_credit", 0)).toEqual([
      { method: "rpc", args: [{ p_client: "c1", p_service: "svc", p_total: 6 }] },
    ]);
    // The RPC always returns a row (consume OR create) — an empty result is a
    // real failure, never a silent null.
    queue("rpc:take_package_credit", { data: [], error: null });
    await expect(ports.takePackageCredit("c1", "svc", 6)).rejects.toThrow("empty result");
  });

  it("refundCredit / deletePackage compensate a failed reservation", async () => {
    const ports = makeReservePorts({ nowMs: NOW });
    await ports.refundCredit("pkg-1");
    expect(callsFor("rpc:adjust_package_credit", 0)).toEqual([{ method: "rpc", args: [{ p_package: "pkg-1", p_delta: -1 }] }]);
    queue("client_packages", { data: [{ id: "pkg-new" }], error: null });
    expect(await ports.deletePackage("pkg-new")).toBe(true);
    const calls = callsFor("client_packages", 0);
    expect(calls.some((c) => c.method === "delete")).toBe(true);
    expect(calls).toContainEqual({ method: "eq", args: ["id", "pkg-new"] });
    expect(calls).toContainEqual({ method: "eq", args: ["used_sessions", 1] });
    queue("client_packages", { data: [], error: null }); // already drawn from → not deleted
    expect(await ports.deletePackage("pkg-new")).toBe(false);
  });
});

describe("insertSession", () => {
  it("maps the exclusion violation to SlotTakenError and writes the pending row", async () => {
    queue("sessions", { data: { id: "s1" }, error: null });
    const ports = makeReservePorts({ nowMs: NOW });
    const row = {
      clientId: "c1",
      attendedBy: "lu",
      startsAt: "2026-09-04T17:00:00.000Z",
      endsAt: "2026-09-04T18:00:00.000Z",
      service: "depilacion",
      note: "Reserva online: Pierna entera",
      pendingConfirmation: true as const,
      bookingServiceId: "0b7a6a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
      packageId: "pkg-1",
    };
    expect(await ports.insertSession(row)).toEqual({ sessionId: "s1" });
    const insert = callsFor("sessions", 0).find((c) => c.method === "insert")!.args[0];
    expect(insert).toMatchObject({
      source: "app",
      status: "scheduled",
      gcal_event_id: null,
      pending_confirmation: true,
      booking_service_id: "0b7a6a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
      package_id: "pkg-1",
      attended_by: "lu",
    });

    queue("sessions", { data: null, error: { code: "23P01", message: "sessions_no_overlap" } });
    await expect(ports.insertSession(row)).rejects.toMatchObject({ name: "SlotTakenError" });
  });
});

// Guards the SlotTaken boundary: ONLY the sessions_no_overlap exclusion
// violation maps to "taken"; any other DB error must propagate as a real
// failure (see reserve.ts — a mis-map would hide outages behind "slot taken").
describe("isExclusionViolation", () => {
  it("matches the exclusion SQLSTATE 23P01", () => {
    expect(isExclusionViolation({ code: "23P01" })).toBe(true);
  });

  it("matches by the sessions_no_overlap constraint name in the message", () => {
    expect(
      isExclusionViolation({
        message: 'conflicting key value violates exclusion constraint "sessions_no_overlap"',
      }),
    ).toBe(true);
  });

  it("does NOT match the validate_app_service FK violation (23503)", () => {
    expect(
      isExclusionViolation({
        code: "23503",
        message: 'service "x" is not a known service_types category',
      }),
    ).toBe(false);
  });

  it("does NOT match an RLS / permission error", () => {
    expect(
      isExclusionViolation({ code: "42501", message: "permission denied for table sessions" }),
    ).toBe(false);
  });

  it("does NOT match an unrelated unique-constraint violation", () => {
    expect(
      isExclusionViolation({
        code: "23505",
        message: 'duplicate key value violates unique constraint "clients_phone_key"',
      }),
    ).toBe(false);
  });

  it("does NOT match an empty / unknown error", () => {
    expect(isExclusionViolation({})).toBe(false);
    expect(isExclusionViolation({ message: "connection reset" })).toBe(false);
  });
});

describe("clientNameByPhone (the greeting after a verified phone)", () => {
  const db = () => serviceClient() as never;

  it("returns the name on file", async () => {
    queue("clients", { data: { id: "c1", full_name: "Ana Prueba" }, error: null });
    expect(await clientNameByPhone(db(), "+59891234567")).toBe("Ana Prueba");
  });

  it("masks the placeholder to null (client exists but never gave a name)", async () => {
    queue("clients", { data: { id: "c1", full_name: PLACEHOLDER_CLIENT_NAME }, error: null });
    expect(await clientNameByPhone(db(), "+59891234567")).toBeNull();
  });

  it("returns null for an unknown phone", async () => {
    queue("clients", { data: null, error: null });
    expect(await clientNameByPhone(db(), "+59891234567")).toBeNull();
  });
});

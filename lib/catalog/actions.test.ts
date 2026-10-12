// Invented data only.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const requireStaff = vi.fn(() =>
  Promise.resolve({ ok: true, email: "staff@example.com" } as { ok: true; email: string } | { error: string }),
);
vi.mock("../auth/require-staff", () => ({ requireStaff: () => requireStaff() }));

type QueryResult = { data: unknown; error: { message: string } | null };
type Call = { method: string; args: unknown[] };
let resultQueue: Record<string, QueryResult[]>;
let callsByTable: Record<string, Call[][]>;
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
      const b: Record<string, unknown> = {};
      for (const m of ["select", "insert", "update", "delete", "eq", "neq", "or", "in", "order", "limit"]) {
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
    },
  }),
}));

import { createService, updateService, setServiceActive } from "./actions";

beforeEach(() => {
  resultQueue = {};
  callsByTable = {};
  requireStaff.mockClear();
  requireStaff.mockResolvedValue({ ok: true, email: "staff@example.com" });
});

describe("createService", () => {
  it("validates then inserts the five columns", async () => {
    queue("booking_services", { data: { id: "svc-1" }, error: null });
    const result = await createService({
      name: "Depilación láser",
      category: "Depilación",
      durationMin: 45,
      priceUyu: 1950,
      packageSessions: null,
    });
    expect(result).toEqual({ ok: true, id: "svc-1" });
    const insert = callsFor("booking_services").find((c) => c.method === "insert")?.args[0] as Record<
      string,
      unknown
    >;
    expect(insert).toEqual({
      name: "Depilación láser",
      category: "Depilación",
      duration_min: 45,
      price_uyu: 1950,
      package_sessions: null,
    });
  });

  it("refuses an invalid draft without touching the DB", async () => {
    expect(await createService({ name: "", durationMin: 45 })).toEqual({
      error: "El nombre no puede estar vacío.",
    });
    expect(callsByTable.booking_services).toBeUndefined();
  });

  it("refuses a non-staff caller", async () => {
    requireStaff.mockResolvedValueOnce({ error: "No autorizado." });
    expect(
      await createService({ name: "Masaje", durationMin: 45 }),
    ).toEqual({ error: "No autorizado." });
    expect(callsByTable.booking_services).toBeUndefined();
  });
});

describe("updateService", () => {
  it("updates by id, pinning the exact column payload", async () => {
    queue("booking_services", { data: { id: "svc-1" }, error: null });
    const result = await updateService({
      id: "11111111-1111-1111-1111-111111111111",
      draft: { name: "Masaje", durationMin: 60, category: null, priceUyu: null, packageSessions: null },
    });
    expect(result).toEqual({ ok: true });
    const calls = callsFor("booking_services");
    expect(calls.find((c) => c.method === "update")?.args[0]).toEqual({
      name: "Masaje",
      category: null,
      duration_min: 60,
      price_uyu: null,
      package_sessions: null,
    });
    expect(calls).toContainEqual({
      method: "eq",
      args: ["id", "11111111-1111-1111-1111-111111111111"],
    });
  });

  it("errors when the id doesn't match a row", async () => {
    queue("booking_services", { data: null, error: null });
    const result = await updateService({
      id: "11111111-1111-1111-1111-111111111111",
      draft: { name: "Masaje", durationMin: 60 },
    });
    expect(result).toEqual({ error: "No se encontró el servicio." });
  });

  it("rejects a malformed id", async () => {
    const result = await updateService({ id: "not-a-uuid", draft: { name: "Masaje", durationMin: 60 } });
    expect(result).toEqual({ error: "Identificador inválido." });
    expect(callsByTable.booking_services).toBeUndefined();
  });
});

describe("setServiceActive", () => {
  it("flips active", async () => {
    queue("booking_services", { data: { id: "svc-1" }, error: null });
    const result = await setServiceActive({ id: "11111111-1111-1111-1111-111111111111", active: false });
    expect(result).toEqual({ ok: true });
    const update = callsFor("booking_services").find((c) => c.method === "update")?.args[0];
    expect(update).toEqual({ active: false });
  });
});

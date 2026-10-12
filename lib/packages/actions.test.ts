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
      for (const m of ["select", "insert", "update", "eq", "neq", "or", "order", "limit"]) {
        b[m] = (...args: unknown[]) => {
          calls.push({ method: m, args });
          return b;
        };
      }
      b.single = () => Promise.resolve(result);
      b.then = (res: (v: QueryResult) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(res, rej);
      return b;
    },
    rpc: (name: string, args: unknown) => {
      const key = `rpc:${name}`;
      const result = resultQueue[key]?.shift() ?? { data: null, error: null };
      (callsByTable[key] ??= []).push([{ method: "rpc", args: [args] }]);
      return Promise.resolve(result);
    },
  }),
}));

import {
  adjustPackageCredit,
  cancelPackage,
  createPackageManually,
  markPackagePaid,
  searchClients,
} from "./actions";

beforeEach(() => {
  resultQueue = {};
  callsByTable = {};
  requireStaff.mockClear();
  requireStaff.mockResolvedValue({ ok: true, email: "staff@example.com" });
});

describe("markPackagePaid", () => {
  it("flips pendiente_pago → pagada with paid_at, guarded", async () => {
    queue("client_packages", { data: [{ id: "pkg-1" }], error: null });
    expect(await markPackagePaid({ packageId: "pkg-1" })).toEqual({ ok: true });
    const calls = callsFor("client_packages");
    const patch = calls.find((c) => c.method === "update")?.args[0] as Record<string, unknown>;
    expect(patch.status).toBe("pagada");
    expect(typeof patch.paid_at).toBe("string");
    expect(calls).toContainEqual({ method: "eq", args: ["status", "pendiente_pago"] });
  });
  it("already paid / unknown → not found", async () => {
    queue("client_packages", { data: [], error: null });
    expect(await markPackagePaid({ packageId: "x" })).toEqual({ error: "No se encontró la cuponera." });
  });
  it("refuses a non-staff caller", async () => {
    requireStaff.mockResolvedValueOnce({ error: "No autorizado." });
    expect(await markPackagePaid({ packageId: "pkg-1" })).toEqual({ error: "No autorizado." });
    expect(callsByTable.client_packages).toBeUndefined();
  });
});

describe("adjustPackageCredit", () => {
  it("moves the ledger through the clamped RPC only", async () => {
    queue("rpc:adjust_package_credit", { data: [{ id: "pkg-1", total_sessions: 6, used_sessions: 4 }], error: null });
    expect(await adjustPackageCredit({ packageId: "pkg-1", delta: 1 })).toEqual({ ok: true });
    expect(callsFor("rpc:adjust_package_credit")).toEqual([{ method: "rpc", args: [{ p_package: "pkg-1", p_delta: 1 }] }]);
    expect(callsByTable.client_packages).toBeUndefined();
  });
  it("rejects any delta other than ±1 and an unknown package", async () => {
    expect(await adjustPackageCredit({ packageId: "pkg-1", delta: 5 as unknown as 1 })).toEqual({ error: "Ajuste inválido." });
    queue("rpc:adjust_package_credit", { data: [], error: null });
    expect(await adjustPackageCredit({ packageId: "x", delta: -1 })).toEqual({ error: "No se encontró la cuponera." });
  });
});

describe("cancelPackage / createPackageManually", () => {
  it("cancels once", async () => {
    queue("client_packages", { data: [{ id: "pkg-1" }], error: null });
    expect(await cancelPackage({ packageId: "pkg-1" })).toEqual({ ok: true });
    expect(callsFor("client_packages")).toContainEqual({ method: "neq", args: ["status", "cancelada"] });
  });
  it("creates a paid package with sessions already used, validated", async () => {
    queue("client_packages", { data: { id: "pkg-9" }, error: null });
    expect(
      await createPackageManually({ clientId: "c1", serviceId: "svc", totalSessions: 6, usedSessions: 2, paid: true }),
    ).toEqual({ ok: true, packageId: "pkg-9" });
    const insert = callsFor("client_packages").find((c) => c.method === "insert")?.args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({ client_id: "c1", booking_service_id: "svc", total_sessions: 6, used_sessions: 2, status: "pagada" });
    expect(await createPackageManually({ clientId: "c1", serviceId: "svc", totalSessions: 0, paid: false })).toEqual({
      error: "La cantidad de sesiones no es válida.",
    });
    expect(await createPackageManually({ clientId: "c1", serviceId: "svc", totalSessions: 6, usedSessions: 7, paid: false })).toEqual({
      error: "Las sesiones usadas no son válidas.",
    });
  });
});

describe("searchClients", () => {
  it("needs 2+ chars, escapes PostgREST filter characters, caps results", async () => {
    expect(await searchClients({ q: "a" })).toEqual({ clients: [] });
    queue("clients", { data: [{ id: "c1", full_name: "Ana Prueba", phone: "+59891234567" }], error: null });
    expect(await searchClients({ q: "ana,(x)%" })).toEqual({
      clients: [{ id: "c1", fullName: "Ana Prueba", phone: "+59891234567" }],
    });
    // The user's ",()%" are stripped so they can't break out of the filter.
    const or = callsFor("clients").find((c) => c.method === "or")?.args[0] as string;
    expect(or).toBe("full_name.ilike.%ana x%,phone.ilike.%ana x%");
    queue("clients", { data: [], error: null });
    await searchClients({ q: "099 123" });
    expect(callsFor("clients", 1).find((c) => c.method === "or")?.args[0]).toBe(
      "full_name.ilike.%099 123%,phone.ilike.%99123%",
    );
    expect(callsFor("clients")).toContainEqual({ method: "limit", args: [8] });
  });
});

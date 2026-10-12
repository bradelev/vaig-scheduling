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

import {
  createStaffMember,
  updateStaffMember,
  setStaffActive,
  setStaffPriority,
  setStaffServices,
} from "./actions";

beforeEach(() => {
  resultQueue = {};
  callsByTable = {};
  requireStaff.mockClear();
  requireStaff.mockResolvedValue({ ok: true, email: "staff@example.com" });
});

describe("createStaffMember", () => {
  it("slugs the name, checks the code is free, inserts", async () => {
    queue("staff", { data: null, error: null }); // lookup: no conflict
    queue("staff", { data: null, error: null }); // insert
    const result = await createStaffMember({ name: "Ana Prueba", phone: "+59891234567", colorId: 2 });
    expect(result).toEqual({ ok: true, id: "anaprueba" });
    const insert = callsFor("staff", 1).find((c) => c.method === "insert")?.args[0] as Record<string, unknown>;
    expect(insert).toEqual({ id: "anaprueba", name: "Ana Prueba", phone: "+59891234567", color_id: 2 });
  });

  it("refuses a slug conflict", async () => {
    queue("staff", { data: { id: "anaprueba" }, error: null }); // lookup: exists
    const result = await createStaffMember({ name: "Ana Prueba" });
    expect(result).toEqual({ error: "Ya existe una profesional con ese código (anaprueba)." });
    // Only one from("staff") call was made (the lookup) — no separate insert call.
    expect(callsByTable.staff).toHaveLength(1);
  });

  it("refuses a name that slugs to nothing (symbols only)", async () => {
    // "!!!" survives draft validation (non-empty after trim) but slugs to "",
    // so this is the case that actually exercises the slug guard.
    const result = await createStaffMember({ name: "!!!" });
    expect(result).toEqual({ error: "El nombre necesita al menos una letra." });
    expect(callsByTable.staff).toBeUndefined();
  });

  it("caps the slug at 40 chars so the id stays editable everywhere", async () => {
    queue("staff", { data: null, error: null }); // no conflict
    queue("staff", { data: null, error: null }); // insert
    const name = "Ana ".concat("b".repeat(56)); // 60 chars -> slug would be 59
    const result = await createStaffMember({ name });
    expect(result).toEqual({ ok: true, id: `ana${"b".repeat(37)}` });
  });

  it("refuses a non-staff caller", async () => {
    requireStaff.mockResolvedValueOnce({ error: "No autorizado." });
    expect(await createStaffMember({ name: "Ana Prueba" })).toEqual({ error: "No autorizado." });
    expect(callsByTable.staff).toBeUndefined();
  });
});

describe("updateStaffMember", () => {
  it("updates by id, pinning the exact column payload", async () => {
    queue("staff", { data: { id: "ana" }, error: null });
    const result = await updateStaffMember({
      id: "ana",
      draft: { name: "Ana Prueba", phone: "+59891234567", colorId: 3 },
    });
    expect(result).toEqual({ ok: true });
    const calls = callsFor("staff");
    expect(calls.find((c) => c.method === "update")?.args[0]).toEqual({
      name: "Ana Prueba",
      phone: "+59891234567",
      color_id: 3,
    });
    expect(calls).toContainEqual({ method: "eq", args: ["id", "ana"] });
  });

  it("errors when not found", async () => {
    queue("staff", { data: null, error: null });
    const result = await updateStaffMember({ id: "ana", draft: { name: "Ana Prueba" } });
    expect(result).toEqual({ error: "No se encontró la profesional." });
  });
});

describe("setStaffActive", () => {
  it("flips active", async () => {
    queue("staff", { data: { id: "ana" }, error: null });
    const result = await setStaffActive({ id: "ana", active: false });
    expect(result).toEqual({ ok: true });
    const update = callsFor("staff").find((c) => c.method === "update")?.args[0];
    expect(update).toEqual({ active: false });
  });
});

describe("setStaffPriority", () => {
  it("bulk-updates staff_services and reports what it matched", async () => {
    queue("staff_services", { data: [{ booking_service_id: "svc-1" }], error: null });
    const result = await setStaffPriority({ id: "ana", priority: 10 });
    expect(result).toEqual({ ok: true });
    const calls = callsFor("staff_services");
    expect(calls.find((c) => c.method === "update")?.args[0]).toEqual({ priority: 10 });
    expect(calls).toContainEqual({ method: "eq", args: ["staff_id", "ana"] });
  });

  it("errors when she has no links yet — a priority stored nowhere must not confirm", async () => {
    queue("staff_services", { data: [], error: null });
    const result = await setStaffPriority({ id: "ana", priority: 10 });
    expect(result).toEqual({
      error: "Todavía no tiene servicios marcados — primero marcá qué servicios da y después fijá la prioridad.",
    });
  });

  it("rejects a bad priority", async () => {
    const result = await setStaffPriority({ id: "ana", priority: 0 });
    expect(result).toEqual({ error: "La prioridad debe ser un número entre 1 y 999." });
    expect(callsByTable.staff_services).toBeUndefined();
  });
});

describe("setStaffServices", () => {
  const svcA = "11111111-1111-1111-1111-111111111111"; // kept
  const svcB = "22222222-2222-2222-2222-222222222222"; // removed
  const svcC = "33333333-3333-3333-3333-333333333333"; // added

  it("diffs current vs wanted: inserts the new one at the mode priority, deletes the dropped one", async () => {
    queue("staff_services", {
      data: [
        { booking_service_id: svcA, priority: 50 },
        { booking_service_id: svcB, priority: 50 },
      ],
      error: null,
    });
    queue("staff_services", { data: null, error: null }); // insert
    queue("staff_services", { data: null, error: null }); // delete

    const result = await setStaffServices({ id: "ana", serviceIds: [svcA, svcC] });
    expect(result).toEqual({ ok: true });

    const insertCall = callsFor("staff_services", 1).find((c) => c.method === "insert");
    expect(insertCall?.args[0]).toEqual([{ staff_id: "ana", booking_service_id: svcC, priority: 50 }]);

    const deleteCalls = callsFor("staff_services", 2);
    expect(deleteCalls.find((c) => c.method === "delete")).toBeDefined();
    expect(deleteCalls).toContainEqual({ method: "eq", args: ["staff_id", "ana"] });
    expect(deleteCalls).toContainEqual({ method: "in", args: ["booking_service_id", [svcB]] });
  });

  it("uses priority 100 for a staff member with no existing links", async () => {
    queue("staff_services", { data: [], error: null });
    queue("staff_services", { data: null, error: null }); // insert

    const result = await setStaffServices({ id: "ana", serviceIds: [svcA] });
    expect(result).toEqual({ ok: true });
    const insertCall = callsFor("staff_services", 1).find((c) => c.method === "insert");
    expect(insertCall?.args[0]).toEqual([{ staff_id: "ana", booking_service_id: svcA, priority: 100 }]);
  });

  it("rejects a non-uuid service id", async () => {
    const result = await setStaffServices({ id: "ana", serviceIds: ["not-a-uuid"] });
    expect(result).toEqual({ error: "Lista de servicios inválida." });
    expect(callsByTable.staff_services).toBeUndefined();
  });

  it("refuses a non-staff caller", async () => {
    requireStaff.mockResolvedValueOnce({ error: "No autorizado." });
    expect(await setStaffServices({ id: "ana", serviceIds: [] })).toEqual({ error: "No autorizado." });
    expect(callsByTable.staff_services).toBeUndefined();
  });
});

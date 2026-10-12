import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The staff gate is covered by lib/auth/staff-actions-guard.test.ts.
vi.mock("../auth/require-staff", () => ({
  requireStaff: () => Promise.resolve({ ok: true, email: "staff@example.com" }),
}));

type QueryResult = {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
};
let resultQueue: Record<string, QueryResult[]>;
let lastUpdate: Record<string, unknown> | null;
let lastInsert: Record<string, unknown> | null;
let deletedTables: string[];

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) b[m] = () => b;
  b.update = (patch: Record<string, unknown>) => {
    lastUpdate = patch;
    return b;
  };
  b.delete = () => {
    deletedTables.push(table);
    return b;
  };
  b.insert = (row: Record<string, unknown>) => {
    lastInsert = row;
    return b;
  };
  const result = () => resultQueue[table]?.shift() ?? { data: null, error: null };
  b.maybeSingle = () => Promise.resolve(result());
  b.single = () => Promise.resolve(result());
  b.then = (res: (v: QueryResult) => unknown) => Promise.resolve(result()).then(res);
  return b;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => makeBuilder(t) }),
}));

function queue(table: string, r: QueryResult) {
  (resultQueue[table] ??= []).push(r);
}

beforeEach(() => {
  resultQueue = {};
  lastUpdate = null;
  lastInsert = null;
  deletedTables = [];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake";
});

describe("updateClient (#128)", () => {
  it("updates the name", async () => {
    const { updateClient } = await import("./actions");
    queue("clients", { data: [{ id: "c1" }], error: null }); // update
    const r = await updateClient({ clientId: "c1", fullName: "Alba Inventada" });
    expect(r).toEqual({ ok: true, phone: undefined });
    expect(lastUpdate).toEqual({ full_name: "Alba Inventada" });
  });

  it("rejects an empty name", async () => {
    const { updateClient } = await import("./actions");
    const r = await updateClient({ clientId: "c1", fullName: "   " });
    expect(r).toEqual({ error: "El nombre no puede quedar vacío." });
  });

  it("normalizes and saves a valid phone (no conflict)", async () => {
    const { updateClient } = await import("./actions");
    queue("clients", { data: null, error: null }); // phone lookup: free
    queue("clients", { data: [{ id: "c1" }], error: null }); // update
    const r = await updateClient({ clientId: "c1", phone: "099123456" });
    expect(r).toEqual({ ok: true, phone: "+59899123456" });
    expect(lastUpdate).toMatchObject({ phone: "+59899123456" });
  });

  it("rejects an invalid phone", async () => {
    const { updateClient } = await import("./actions");
    const r = await updateClient({ clientId: "c1", phone: "123" });
    expect(r).toEqual({ error: "El teléfono no es válido." });
  });

  it("refuses a phone that belongs to ANOTHER client", async () => {
    const { updateClient } = await import("./actions");
    queue("clients", { data: { id: "c2", full_name: "Otra Inventada" }, error: null });
    const r = await updateClient({ clientId: "c1", phone: "099123456" });
    expect(r).toEqual({ error: 'Ese teléfono ya es de "Otra Inventada".' });
  });

  it("allows re-saving the SAME client's own phone (no false conflict)", async () => {
    const { updateClient } = await import("./actions");
    queue("clients", { data: { id: "c1", full_name: "Alba" }, error: null }); // owner IS c1
    queue("clients", { data: [{ id: "c1" }], error: null }); // update
    const r = await updateClient({ clientId: "c1", phone: "099123456" });
    expect(r).toEqual({ ok: true, phone: "+59899123456" });
  });

  it("toggles is_first_visit", async () => {
    const { updateClient } = await import("./actions");
    queue("clients", { data: [{ id: "c1" }], error: null });
    await updateClient({ clientId: "c1", isFirstVisit: false });
    expect(lastUpdate).toEqual({ is_first_visit: false });
  });

  it("errors when the client is not found", async () => {
    const { updateClient } = await import("./actions");
    queue("clients", { data: [], error: null });
    const r = await updateClient({ clientId: "missing", fullName: "X" });
    expect(r).toEqual({ error: "No se encontró la clienta." });
  });
});

describe("createClient (add to the book, no session)", () => {
  it("creates a client with name + phone", async () => {
    const { createClient } = await import("./actions");
    queue("clients", { data: null, error: null }); // phone lookup: free
    queue("clients", { data: { id: "new-1" }, error: null }); // insert
    const r = await createClient({
      fullName: "Alba Inventada",
      phone: "099123456",
    });
    expect(r).toEqual({ ok: true, clientId: "new-1", reused: false });
    expect(lastInsert).toMatchObject({
      full_name: "Alba Inventada",
      phone: "+59899123456",
    });
  });

  it("reports reused (no insert) when name+phone already exist", async () => {
    const { createClient } = await import("./actions");
    // phone lookup finds the same person (same name) → reuse, no insert.
    queue("clients", {
      data: { id: "c-existing", full_name: "Alba Inventada" },
      error: null,
    });
    const r = await createClient({
      fullName: "Alba Inventada",
      phone: "099123456",
    });
    expect(r).toEqual({ ok: true, clientId: "c-existing", reused: true });
    expect(lastInsert).toBeNull();
  });

  it("rejects an invalid phone", async () => {
    const { createClient } = await import("./actions");
    const r = await createClient({ fullName: "Alba", phone: "123" });
    expect(r).toEqual({ error: "El teléfono no es válido." });
  });

  it("rejects an empty name", async () => {
    const { createClient } = await import("./actions");
    const r = await createClient({ fullName: "  ", phone: "099123456" });
    expect(r).toEqual({ error: "Falta el nombre." });
  });

  it("refuses a phone owned by ANOTHER client (conflict)", async () => {
    const { createClient } = await import("./actions");
    queue("clients", {
      data: { id: "c2", full_name: "Otra Inventada" },
      error: null,
    });
    const r = await createClient({
      fullName: "Alba Inventada",
      phone: "099123456",
    });
    expect(r).toMatchObject({
      error: expect.stringContaining('ya es de "Otra Inventada"'),
    });
  });
});

describe("deleteClient (only when she has no sessions)", () => {
  it("deletes a client with zero sessions", async () => {
    const { deleteClient } = await import("./actions");
    queue("sessions", { data: null, error: null, count: 0 }); // session count
    queue("clients", { data: [{ id: "c1" }], error: null }); // delete
    const r = await deleteClient({ clientId: "c1" });
    expect(r).toEqual({ ok: true });
    expect(deletedTables).toEqual(["clients"]);
  });

  it("REFUSES to delete a client who has sessions (guards the cascade)", async () => {
    const { deleteClient } = await import("./actions");
    queue("sessions", { data: null, error: null, count: 3 });
    const r = await deleteClient({ clientId: "c1" });
    expect(r).toMatchObject({
      error: expect.stringContaining("3 sesiones"),
    });
    // Never reached the delete — the client (and her sessions) survive.
    expect(deletedTables).toEqual([]);
  });

  it("REFUSES even a single (e.g. cancelled) session — count is authoritative", async () => {
    const { deleteClient } = await import("./actions");
    queue("sessions", { data: null, error: null, count: 1 });
    const r = await deleteClient({ clientId: "c1" });
    expect(r).toMatchObject({
      error: expect.stringContaining("1 sesión"),
    });
    expect(deletedTables).toEqual([]);
  });

  it("errors when the client is not found", async () => {
    const { deleteClient } = await import("./actions");
    queue("sessions", { data: null, error: null, count: 0 });
    queue("clients", { data: [], error: null }); // delete matched nothing
    const r = await deleteClient({ clientId: "missing" });
    expect(r).toEqual({ error: "No se encontró la clienta." });
  });

  it("surfaces a count error without deleting", async () => {
    const { deleteClient } = await import("./actions");
    queue("sessions", { data: null, error: { message: "boom" } });
    const r = await deleteClient({ clientId: "c1" });
    expect(r).toMatchObject({ error: expect.stringContaining("boom") });
    expect(deletedTables).toEqual([]);
  });
});

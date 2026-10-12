import { beforeEach, describe, expect, it } from "vitest";
import {
  assertPhoneFree,
  findOrCreateClient,
  newClientDecision,
  phoneConflictMessage,
} from "./upsert";

// Minimal chainable mock of the Supabase client for the two DB shapes used:
// .from(t).select(c).eq(col,v).maybeSingle() and .from(t).insert(row).select(c).single().
type Res = { data: unknown; error: { message: string } | null };
let lookupResult: Res;
let insertResult: Res;
let insertedRow: Record<string, unknown> | null;

function db() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve(lookupResult) }),
      }),
      insert: (row: Record<string, unknown>) => {
        insertedRow = row;
        return { select: () => ({ single: () => Promise.resolve(insertResult) }) };
      },
    }),
    // deno-lint-ignore no-explicit-any
  } as any;
}

beforeEach(() => {
  lookupResult = { data: null, error: null };
  insertResult = { data: { id: "new-1" }, error: null };
  insertedRow = null;
});

describe("newClientDecision", () => {
  it("create / reuse / conflict", () => {
    expect(newClientDecision(null, "Ana")).toBe("create");
    expect(newClientDecision({ full_name: " ana " }, "Ana")).toBe("reuse");
    expect(newClientDecision({ full_name: "Ana Pérez" }, "Otra")).toBe("conflict");
  });
});

describe("findOrCreateClient", () => {
  it("creates a new client, passing is_first_visit", async () => {
    const r = await findOrCreateClient(db(), {
      fullName: "Alba Inventada",
      phone: "099123456",
      isFirstVisit: true,
    });
    expect(r).toEqual({ clientId: "new-1", reused: false });
    expect(insertedRow).toEqual({
      full_name: "Alba Inventada",
      phone: "+59899123456",
      is_first_visit: true,
    });
  });

  it("defaults is_first_visit to false when omitted", async () => {
    await findOrCreateClient(db(), { fullName: "Beatriz Inventada", phone: "099123456" });
    expect(insertedRow).toMatchObject({ is_first_visit: false });
  });

  it("reuses an existing client with the same name+phone (no insert)", async () => {
    lookupResult = { data: { id: "c-existing", full_name: "Alba Inventada" }, error: null };
    const r = await findOrCreateClient(db(), { fullName: "Alba Inventada", phone: "099123456" });
    expect(r).toEqual({ clientId: "c-existing", reused: true });
    expect(insertedRow).toBeNull();
  });

  it("refuses a phone owned by a different name (conflict, single message)", async () => {
    lookupResult = { data: { id: "c-x", full_name: "Otra Inventada" }, error: null };
    const r = await findOrCreateClient(db(), { fullName: "Alba Inventada", phone: "099123456" });
    expect(r).toEqual({ error: phoneConflictMessage("Otra Inventada") });
  });

  it("rejects empty name and invalid phone", async () => {
    expect(await findOrCreateClient(db(), { fullName: "  ", phone: "099123456" }))
      .toEqual({ error: "Falta el nombre." });
    expect(await findOrCreateClient(db(), { fullName: "Alba", phone: "123" }))
      .toEqual({ error: "El teléfono no es válido." });
  });
});

describe("assertPhoneFree", () => {
  it("null when free", async () => {
    expect(await assertPhoneFree(db(), "+59899123456", "c1")).toBeNull();
  });
  it("null when the phone is the SAME client's own", async () => {
    lookupResult = { data: { id: "c1", full_name: "Alba" }, error: null };
    expect(await assertPhoneFree(db(), "+59899123456", "c1")).toBeNull();
  });
  it("error when owned by ANOTHER client", async () => {
    lookupResult = { data: { id: "c2", full_name: "Otra Inventada" }, error: null };
    expect(await assertPhoneFree(db(), "+59899123456", "c1")).toBe(
      'Ese teléfono ya es de "Otra Inventada".',
    );
  });
});

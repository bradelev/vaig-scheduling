import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchStaff,
  fetchStaffById,
  isKnownStaff,
  staffColorId,
} from "./staff";

// Chainable mock: .select().eq().eq().order()/.maybeSingle() all resolve to a
// per-call queued result. `order` returns the queued list (fetchStaff); the
// terminal awaits (maybeSingle) return the queued single/null.
let listResult: { data: unknown; error: unknown };
let singleResult: { data: unknown; error: unknown };

function db(): SupabaseClient {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) b[m] = () => b;
  b.order = () => Promise.resolve(listResult);
  b.maybeSingle = () => Promise.resolve(singleResult);
  // deno-lint-ignore no-explicit-any
  return { from: () => b } as any;
}

beforeEach(() => {
  listResult = {
    data: [
      { id: "cyn", name: "Cyn", phone: "+59891234567", color_id: 6 },
      { id: "lu", name: "Lu", phone: null, color_id: 1 },
    ],
    error: null,
  };
  singleResult = { data: null, error: null };
});

describe("fetchStaff", () => {
  it("maps DB rows to the Staff shape (name→label)", async () => {
    const out = await fetchStaff(db());
    expect(out).toEqual([
      { id: "cyn", label: "Cyn", phone: "+59891234567", colorId: 6 },
      { id: "lu", label: "Lu", phone: null, colorId: 1 },
    ]);
  });

  it("returns [] on error", async () => {
    listResult = { data: null, error: { message: "boom" } };
    expect(await fetchStaff(db())).toEqual([]);
  });
});

describe("fetchStaffById", () => {
  it("returns the mapped staff row", async () => {
    singleResult = {
      data: { id: "lu", name: "Lu", phone: "+598...", color_id: 1 },
      error: null,
    };
    expect(await fetchStaffById(db(), "lu")).toEqual({
      id: "lu",
      label: "Lu",
      phone: "+598...",
      colorId: 1,
    });
  });

  it("returns null for a null/undefined id without hitting the DB", async () => {
    expect(await fetchStaffById(db(), null)).toBeNull();
    expect(await fetchStaffById(db(), undefined)).toBeNull();
  });
});

describe("staffColorId", () => {
  it("returns the colorId for a known staff id", async () => {
    singleResult = {
      data: { id: "cyn", name: "Cyn", phone: null, color_id: 6 },
      error: null,
    };
    expect(await staffColorId(db(), "cyn")).toBe(6);
  });

  it("returns null for null / unknown", async () => {
    expect(await staffColorId(db(), null)).toBeNull();
    singleResult = { data: null, error: null };
    expect(await staffColorId(db(), "valentina")).toBeNull();
  });
});

describe("isKnownStaff", () => {
  it("true when the row exists (active)", async () => {
    singleResult = { data: { id: "lu" }, error: null };
    expect(await isKnownStaff(db(), "lu")).toBe(true);
  });

  it("false when no row", async () => {
    singleResult = { data: null, error: null };
    expect(await isKnownStaff(db(), "nobody")).toBe(false);
  });
});

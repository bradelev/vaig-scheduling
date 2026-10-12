import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the server Supabase client: fetchClientsForPicker does
// .from("clients").select(cols).order("full_name").
type Res = { data: unknown; error: { message: string } | null };
let queryResult: Res;

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        order: () => Promise.resolve(queryResult),
      }),
    }),
  }),
}));

import { fetchClientsForPicker } from "./pick";

beforeEach(() => {
  queryResult = { data: [], error: null };
});

describe("fetchClientsForPicker", () => {
  it("returns the client rows on success", async () => {
    queryResult = {
      data: [
        { id: "c-1", full_name: "Ana Inventada", phone: "+59891234567" },
        { id: "c-2", full_name: "Beatriz Existente", phone: "+59899999999" },
      ],
      error: null,
    };
    const rows = await fetchClientsForPicker();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "c-1",
      full_name: "Ana Inventada",
      phone: "+59891234567",
    });
  });

  it("returns [] when the query yields null data", async () => {
    queryResult = { data: null, error: null };
    expect(await fetchClientsForPicker()).toEqual([]);
  });

  it("throws a wrapped error on a Supabase failure", async () => {
    queryResult = { data: null, error: { message: "boom" } };
    await expect(fetchClientsForPicker()).rejects.toThrow(
      "fetchClientsForPicker: boom",
    );
  });
});

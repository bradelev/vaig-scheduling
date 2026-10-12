// Invented data only.
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryResult = { error: { message: string } | null };
let updateCalls: { table: string; values: Record<string, unknown> }[];
let eqCalls: unknown[][];
let result: QueryResult;

vi.mock("../supabase/server", () => ({
  createClient: () => ({
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => {
        updateCalls.push({ table, values });
        return {
          eq: (...args: unknown[]) => {
            eqCalls.push(args);
            return Promise.resolve(result);
          },
        };
      },
    }),
  }),
}));

const requireStaff = vi.fn();
vi.mock("../auth/require-staff", () => ({
  requireStaff: (...args: unknown[]) => requireStaff(...args),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
}));

import { markReviewed, markReviewRequested } from "./actions";

beforeEach(() => {
  updateCalls = [];
  eqCalls = [];
  result = { error: null };
  requireStaff.mockReset().mockResolvedValue({ ok: true, email: "staff@example.com" });
  revalidatePath.mockClear();
});

describe("markReviewed", () => {
  it("sets reviewed_at for the client and revalidates the screen", async () => {
    await markReviewed("client-1");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].table).toBe("clients");
    expect(Object.keys(updateCalls[0].values)).toEqual(["reviewed_at"]);
    expect(typeof updateCalls[0].values.reviewed_at).toBe("string");
    expect(eqCalls[0]).toEqual(["id", "client-1"]);
    expect(revalidatePath).toHaveBeenCalledWith("/resenas");
  });

  it("refuses a non-staff caller WITHOUT touching the DB", async () => {
    requireStaff.mockResolvedValueOnce({ error: "No autorizado." });
    await expect(markReviewed("client-1")).rejects.toThrow("No autorizado.");
    expect(updateCalls).toHaveLength(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("surfaces a DB error (the button shows it and lets the user retry)", async () => {
    result = { error: { message: "boom" } };
    await expect(markReviewed("client-1")).rejects.toThrow("boom");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("markReviewRequested", () => {
  it("sets review_requested_at (the grace window) and revalidates", async () => {
    await markReviewRequested("client-2");
    expect(Object.keys(updateCalls[0].values)).toEqual(["review_requested_at"]);
    expect(eqCalls[0]).toEqual(["id", "client-2"]);
    expect(revalidatePath).toHaveBeenCalledWith("/resenas");
  });

  it("refuses a non-staff caller WITHOUT touching the DB", async () => {
    requireStaff.mockResolvedValueOnce({ error: "No autorizado." });
    await expect(markReviewRequested("client-2")).rejects.toThrow("No autorizado.");
    expect(updateCalls).toHaveLength(0);
  });
});

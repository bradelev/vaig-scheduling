import { beforeEach, describe, expect, it, vi } from "vitest";

const state: { count: number | null; error: string | null; env: boolean } = { count: 0, error: null, env: true };
vi.mock("../supabase/server", () => ({
  hasSupabaseEnv: () => state.env,
  createClient: () => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) b[m] = () => b;
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ count: state.count, error: state.error ? { message: state.error } : null }).then(resolve);
    return { from: () => b };
  },
}));

import { getPendingCount } from "./pending-count";

beforeEach(() => {
  state.count = 0;
  state.error = null;
  state.env = true;
});

describe("getPendingCount (nav badge)", () => {
  it("returns the count", async () => {
    state.count = 4;
    expect(await getPendingCount()).toBe(4);
  });
  it("is decoration: null on error or when Supabase isn't configured", async () => {
    state.error = "boom";
    expect(await getPendingCount()).toBeNull();
    state.error = null;
    state.env = false;
    expect(await getPendingCount()).toBeNull();
  });
});

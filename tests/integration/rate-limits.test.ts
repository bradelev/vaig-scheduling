/**
 * Per-IP rate limiter integration test (CI-only): the SQL fixed-window
 * counter behind the public endpoints (migration 20260830165310). Exercised
 * against a real Postgres: allow up to the limit, refuse with a retry-after,
 * reset after the window, and not callable as anon.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";

const KEY = "itest:203.0.113.9";
let service: SupabaseClient;
let anon: SupabaseClient;

type Row = { allowed: boolean; retry_after_sec: number };
async function hit(limit: number, windowSec: number): Promise<Row> {
  const { data, error } = await service.rpc("rate_limit_hit", { p_key: KEY, p_limit: limit, p_window_sec: windowSec });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data : [data])[0] as Row;
}

beforeAll(() => {
  const { url, anonKey, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);
  anon = createClient(url, anonKey, clientOptions);
});

afterAll(async () => {
  await service.from("rate_limits").delete().eq("key", KEY);
});

describe("rate_limit_hit", () => {
  it("allows up to the limit, then refuses with the seconds until the window resets", async () => {
    // 3-second window: the four calls must land inside it even on a slow CI.
    for (let i = 0; i < 3; i++) expect((await hit(3, 3)).allowed).toBe(true);
    const refused = await hit(3, 3);
    expect(refused.allowed).toBe(false);
    expect(refused.retry_after_sec).toBeGreaterThanOrEqual(1);
    expect(refused.retry_after_sec).toBeLessThanOrEqual(3);
  });

  it("starts a fresh window once the previous one expired", async () => {
    await new Promise((r) => setTimeout(r, 3200));
    const again = await hit(3, 3);
    expect(again).toEqual({ allowed: true, retry_after_sec: 0 });
  });

  it("is not callable as anon, and the table is invisible to anon", async () => {
    const fn = await anon.rpc("rate_limit_hit", { p_key: KEY, p_limit: 1, p_window_sec: 60 });
    expect(fn.error?.code).toBe("42501");
    const tbl = await anon.from("rate_limits").select("key").limit(1);
    expect(tbl.error).not.toBeNull();
  });
});

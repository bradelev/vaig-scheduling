// Invented data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clientIpFrom, hitRateLimit, RATE_LIMITS, rateLimitKey, rateLimitedResponse } from "./rate-limit";

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe("clientIpFrom", () => {
  it("takes the first x-forwarded-for entry (the client), trimmed", () => {
    expect(clientIpFrom(headers({ "x-forwarded-for": " 203.0.113.7 , 10.0.0.1" }))).toBe("203.0.113.7");
  });
  it("falls back to x-real-ip, then 'unknown'", () => {
    expect(clientIpFrom(headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIpFrom(headers({ "x-forwarded-for": " , " }))).toBe("unknown");
    expect(clientIpFrom(headers({}))).toBe("unknown");
  });
  it("accepts IPv6, rejects non-IP-shaped text (no unbounded keys)", () => {
    expect(clientIpFrom(headers({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIpFrom(headers({ "x-forwarded-for": "evil' or 1=1" }))).toBe("unknown");
    expect(clientIpFrom(headers({ "x-forwarded-for": "a".repeat(200) }))).toBe("unknown");
  });
  it("keys are scope:ip", () => {
    expect(rateLimitKey(RATE_LIMITS.requestCode, "203.0.113.7")).toBe("request-code:203.0.113.7");
  });
});

describe("hitRateLimit", () => {
  let err: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => err.mockRestore());

  const db = (result: { data?: unknown; error?: { message: string } | null; throws?: boolean }) =>
    ({
      rpc: vi.fn(async () => {
        if (result.throws) throw new Error("network");
        return { data: result.data ?? null, error: result.error ?? null };
      }),
    }) as unknown as SupabaseClient;

  it("passes the key, limit and window to the RPC and maps allowed", async () => {
    const d = db({ data: [{ allowed: true, retry_after_sec: 0 }] });
    expect(await hitRateLimit(d, RATE_LIMITS.reserve, "203.0.113.7")).toEqual({ allowed: true });
    expect((d.rpc as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      "rate_limit_hit",
      { p_key: "reservar:203.0.113.7", p_limit: 20, p_window_sec: 900 },
    ]);
  });
  it("maps a refusal with its retry-after (at least 1s)", async () => {
    expect(await hitRateLimit(db({ data: [{ allowed: false, retry_after_sec: 42 }] }), RATE_LIMITS.reserve, "x")).toEqual({
      allowed: false,
      retryAfterSec: 42,
    });
    expect(await hitRateLimit(db({ data: [{ allowed: false, retry_after_sec: 0 }] }), RATE_LIMITS.reserve, "x")).toEqual({
      allowed: false,
      retryAfterSec: 1,
    });
  });
  it("fails CLOSED when the limiter errors, throws or returns nothing", async () => {
    for (const d of [db({ error: { message: "boom" } }), db({ throws: true }), db({ data: [] })]) {
      expect(await hitRateLimit(d, RATE_LIMITS.verifyCode, "x")).toEqual({ allowed: false, retryAfterSec: 30 });
    }
    expect(err).toHaveBeenCalled();
    // The log names the scope, never the IP.
    expect(String(err.mock.calls[0][0])).not.toContain("x:");
  });
  it("the 429 carries Retry-After", async () => {
    const res = rateLimitedResponse(17);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(await res.json()).toEqual({ error: "Demasiados intentos. Probá de nuevo en unos minutos." });
  });
});

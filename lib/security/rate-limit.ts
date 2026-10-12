/**
 * Per-IP rate limiting for the public surface (request-code, verify-code,
 * /api/reservar, the public availability read). The counter lives in
 * Postgres (migration rate_limits, function rate_limit_hit) so every
 * serverless instance shares it. Fail-CLOSED: if the limiter can't be
 * consulted the request is refused (the same DB serves the request anyway).
 *
 * Defense in depth only — the forwarded IP is what the edge reports; the
 * per-phone OTP limits and the per-client pending cap stay the strong gates.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export type RateLimitRule = {
  /** Key prefix; one counter per scope+ip. */
  scope: string;
  /** Hits allowed per window. */
  limit: number;
  windowSec: number;
};

/**
 * Generous for people, tight for a script. Sized for SHARED IPs: Uruguayan
 * mobile carriers use CGNAT (several clients answering a reactivation blast
 * can share one public IPv4) and the clinic's own Wi-Fi is one IP for staff
 * helping walk-ins. The per-phone OTP limits (3 codes / 15 min, 5 attempts
 * per code) and the per-client pending cap stay the strong gates.
 */
export const RATE_LIMITS = {
  /** Each hit sends a WhatsApp (cost): 15 per 15 min per IP = 60/hour bounded. */
  requestCode: { scope: "request-code", limit: 15, windowSec: 15 * 60 },
  /** Code guessing is already capped per code/phone; this only bounds DB work. */
  verifyCode: { scope: "verify-code", limit: 60, windowSec: 15 * 60 },
  /** Reservations need a verified session + the 3-pending cap. */
  reserve: { scope: "reservar", limit: 20, windowSec: 15 * 60 },
  /** Week reads while browsing: normally 1–2 per week/staff change, but the
   *  empty-week auto-advance scan can spend up to ~10 in one entry when a
   *  selection has no slots at all — 120 per 5 min per IP absorbs both. */
  publicWeek: { scope: "public-week", limit: 120, windowSec: 5 * 60 },
  /** Anonymous funnel events: tiny rows, fire-and-forget — generous but capped. */
  eventos: { scope: "eventos", limit: 300, windowSec: 5 * 60 },
  /** Recovery-intent upsert: one per verified visitor, retried at most a few times. */
  interes: { scope: "interes", limit: 30, windowSec: 15 * 60 },
  /** Staff login, per IP: each send emails a code; the clinic Wi-Fi is one IP. */
  staffSendCode: { scope: "staff-send-code", limit: 10, windowSec: 15 * 60 },
  staffVerifyCode: { scope: "staff-verify-code", limit: 20, windowSec: 15 * 60 },
  /** Staff login, per EMAIL: bounds distributed guessing of a 6-digit code
   *  on the few shared staff accounts (Supabase's own limit only sees the
   *  Vercel egress IP, not the attacker's). */
  staffVerifyEmail: { scope: "staff-verify-email", limit: 15, windowSec: 15 * 60 },
} as const satisfies Record<string, RateLimitRule>;

type HeaderReader = { get(name: string): string | null };

/** IPv4 / IPv6 textual shape (max 45 chars). Anything else is not an IP. */
const IP_SHAPE = /^[0-9a-fA-F.:]{1,45}$/;

/**
 * The caller's IP as the edge reports it. Trust basis: Vercel OVERWRITES
 * x-forwarded-for with the connecting client's IP (it does not forward an
 * externally supplied value), so the first entry is the client and is not
 * spoofable in this deployment. If the app ever sits behind another proxy
 * (Cloudflare…), revisit — that proxy's IP would become everyone's bucket.
 * Falls back to x-real-ip, then "unknown" (local dev: one shared bucket,
 * still counted — never a bypass). Non-IP-shaped values are treated as
 * "unknown" so attacker text can't mint unbounded keys.
 */
export function clientIpFrom(headers: HeaderReader): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first && IP_SHAPE.test(first)) return first;
  }
  const real = headers.get("x-real-ip")?.trim();
  return real && IP_SHAPE.test(real) ? real : "unknown";
}

export function rateLimitKey(rule: RateLimitRule, ip: string): string {
  return `${rule.scope}:${ip}`;
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSec: number };

/** Seconds a caller waits when the limiter itself failed (fail-closed). */
const FAIL_CLOSED_RETRY_SEC = 30;

/** One hit for this IP under the rule. Never throws. */
export async function hitRateLimit(
  db: SupabaseClient,
  rule: RateLimitRule,
  ip: string,
): Promise<RateLimitDecision> {
  try {
    const { data, error } = await db.rpc("rate_limit_hit", {
      p_key: rateLimitKey(rule, ip),
      p_limit: rule.limit,
      p_window_sec: rule.windowSec,
    });
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as
      | { allowed: boolean; retry_after_sec: number }
      | undefined;
    if (!row) throw new Error("empty result");
    if (row.allowed) return { allowed: true };
    return { allowed: false, retryAfterSec: Math.max(1, Number(row.retry_after_sec) || 1) };
  } catch (err) {
    // Fail closed, but never leak the IP into logs beyond the scope.
    console.error(
      `rate-limit ${rule.scope}: limiter unavailable (${err instanceof Error ? err.message : String(err)})`,
    );
    return { allowed: false, retryAfterSec: FAIL_CLOSED_RETRY_SEC };
  }
}

/** The 429 the public routes send, with Retry-After for well-behaved clients. */
export function rateLimitedResponse(retryAfterSec: number): NextResponse {
  return NextResponse.json(
    { error: "Demasiados intentos. Probá de nuevo en unos minutos." },
    { status: 429, headers: { "retry-after": String(retryAfterSec) } },
  );
}

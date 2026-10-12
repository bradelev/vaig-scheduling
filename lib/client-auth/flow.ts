/**
 * Client phone-login FLOW (Phase 1 slice 3): the request-code / verify-code
 * orchestration, with all I/O injected as ports so the security-critical
 * ordering is pure and unit-tested. The route handlers wire the real ports
 * (DB, WhatsApp, Supabase admin); the tests wire fakes.
 *
 * SECURITY INVARIANTS enforced here (not in the handlers):
 *  - Anti-enumeration: request-code returns the SAME result whether or not the
 *    phone is a known client, and verify-code returns a SINGLE generic failure
 *    for every not-ok reason (wrong code / expired / exhausted / consumed / no
 *    code) — never revealing which.
 *  - Rate limit BEFORE issuing (mayIssue) and attempt cap on verify.
 *  - The phone is always the normalized E.164 (callers pass the normalized
 *    value; we never hash raw input).
 *  - On a wrong code we burn an attempt (the port does the atomic increment).
 */
import {
  generateCode,
  hashCode,
  verifyCodeHash,
  codeUsable,
  mayIssue,
  expiryFrom,
  DAY_WINDOW_MS,
  type CodeRecord,
} from "./otp";

/** Ports the flow needs — real impls in the route handlers, fakes in tests. */
export type OtpPorts = {
  /** How many codes were created for this phone within the rate window. */
  recentCodeCount(phone: string, sinceMs: number): Promise<number>;
  /** Persist a new code row. Returns nothing. */
  insertCode(row: {
    phone: string;
    codeHash: string;
    expiresAt: string;
  }): Promise<void>;
  /** Send the code to the phone via WhatsApp (or a stub in dev/test). */
  sendCode(phone: string, code: string): Promise<void>;
  /** The newest still-active code row for the phone, or null. */
  activeCode(phone: string): Promise<(CodeRecord & { id: string }) | null>;
  /** Atomically bump attempts IF still under the cap. Returns the new count, or
   *  null when the row was already at/over the cap (this guess doesn't count —
   *  the flow fails). Race-safe: the guard + increment are one atomic UPDATE. */
  bumpAttempts(codeId: string): Promise<number | null>;
  /** Mark a code consumed (single-use) on the successful verify. */
  consumeCode(codeId: string): Promise<void>;
  /** Find-or-create the auth+client identity for a verified phone and mint a
   *  session. Sets app_metadata.phone server-side (never client input). */
  establishSession(phone: string): Promise<void>;
  /** The server pepper (env secret). */
  pepper: string;
  /** Injected clock (ms) for deterministic tests. */
  nowMs: number;
  /** The rate window length (ms) — from otp.RATE_WINDOW_MS by default. */
  rateWindowMs: number;
};

/** request-code always resolves to this — generic, no enumeration signal. */
export type RequestResult = { ok: true } | { ok: false; reason: "rate_limited" };

/**
 * Issue a code: rate-limit → generate → hash → store → send. Returns a generic
 * ok (or rate_limited). NEVER reveals whether the phone is a known client.
 */
export async function requestCode(
  phone: string,
  ports: OtpPorts,
): Promise<RequestResult> {
  const recent = await ports.recentCodeCount(
    phone,
    ports.nowMs - ports.rateWindowMs,
  );
  const daily = await ports.recentCodeCount(phone, ports.nowMs - DAY_WINDOW_MS);
  if (!mayIssue(recent, daily)) return { ok: false, reason: "rate_limited" };

  const code = generateCode();
  const codeHash = await hashCode(phone, code, ports.pepper);
  await ports.insertCode({
    phone,
    codeHash,
    expiresAt: expiryFrom(ports.nowMs),
  });
  await ports.sendCode(phone, code);
  return { ok: true };
}

/** verify-code resolves to this — a single generic failure for every bad path. */
export type VerifyResult = { ok: true } | { ok: false };

/**
 * Verify a code. Fetch the active code, bump attempts FIRST (so a wrong guess
 * costs one), constant-time-compare, and on success consume it + establish the
 * session. Every failure path returns the same generic { ok: false }.
 */
export async function verifyCode(
  phone: string,
  candidate: string,
  ports: OtpPorts,
): Promise<VerifyResult> {
  const rec = await ports.activeCode(phone);
  if (!rec) return { ok: false };

  // Re-check usability against the injected clock (the query filters too, but
  // this is the authoritative pure gate).
  if (codeUsable(rec, ports.nowMs) !== "ok") return { ok: false };

  // Burn an attempt before comparing — a wrong guess must count even if the
  // request is retried. The bump is a conditional atomic UPDATE: null means the
  // row was already at/over the cap (concurrency can't buy extra guesses), so
  // this verify fails without even comparing.
  const bumped = await ports.bumpAttempts(rec.id);
  if (bumped === null) return { ok: false };

  const match = await verifyCodeHash(phone, candidate, rec.code_hash, ports.pepper);
  if (!match) return { ok: false };

  await ports.consumeCode(rec.id);
  await ports.establishSession(phone);
  return { ok: true };
}

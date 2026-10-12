/**
 * Client phone-login OTP — pure security logic (Phase 1 of the public-booking
 * plan). Generate / hash / compare login codes and decide expiry, attempts and
 * rate-limits. NO I/O — every function is a pure transform, so the security
 * core is exhaustively unit-tested; the thin DB/WhatsApp shell lives in the
 * route handlers. Architect-owned, never delegated (same posture as
 * wa-webhook/logic.ts).
 *
 * The code is delivered by WhatsApp (Braulio, 2026-08-28) — we generate and
 * verify it ourselves; the session is minted via the Supabase admin API on
 * success (see the verify route). Parameters confirmed by Braulio:
 *   6-digit code, 10-minute expiry (raised from 5 on 2026-08-31 to match the
 *   approved codigo_login template footer "Vence en 10 minutos"), 5 verify
 *   attempts per code, at most 3 codes per phone per 15 minutes.
 */
import { webcrypto } from "node:crypto";

/** Confirmed policy constants (Braulio, 2026-08-28). */
export const CODE_LENGTH = 6;
// Must match the template's code_expiration_minutes — the message is a promise.
export const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_ATTEMPTS = 5; // verify attempts per code
export const MAX_CODES_PER_WINDOW = 3; // per phone
export const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
/** Daily cap per phone. The 15-minute window alone allows ~288 codes/day: a
 *  slow guesser gets 5 tries on each, and each code is a paid WhatsApp send. */
export const MAX_CODES_PER_DAY = 10;
export const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A cryptographically-random N-digit code as a zero-padded string. Uses the
 * crypto RNG (never Math.random) and rejection sampling so every value in
 * [0, 10^N) is equally likely (no modulo bias).
 */
export function generateCode(length: number = CODE_LENGTH): string {
  if (length < 1 || length > 9) throw new Error("code length out of range");
  const max = 10 ** length; // exclusive upper bound
  // Largest multiple of `max` that fits in 32 bits — reject above it to avoid bias.
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  let n: number;
  do {
    webcrypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= limit);
  return String(n % max).padStart(length, "0");
}

/**
 * Hash a code for storage. NOT a plain hash of the digits (10^6 space is
 * rainbow-tableable if the DB leaks): the hash is bound to the phone AND a
 * server pepper (an env secret not in the DB), so a leaked hash reveals nothing
 * without both. Short expiry + attempt cap make a heavier KDF unnecessary.
 * Returns lowercase hex.
 */
export async function hashCode(
  phone: string,
  code: string,
  pepper: string,
): Promise<string> {
  if (!pepper) throw new Error("missing OTP pepper");
  const material = `${phone}:${code}:${pepper}`;
  const digest = await webcrypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Constant-time compare of a candidate code against a stored hash. Recomputes
 * the candidate's hash (same phone+pepper) and byte-compares — so the compare
 * time doesn't leak how many leading characters matched. Reuses the
 * timingSafeEqual pattern from wa-webhook/logic.ts.
 */
export async function verifyCodeHash(
  phone: string,
  candidate: string,
  storedHash: string,
  pepper: string,
): Promise<boolean> {
  const expected = await hashCode(phone, candidate, pepper);
  const a = hexToBytes(expected);
  const b = hexToBytes(storedHash);
  if (!a || !b) return false;
  return timingSafeEqual(a, b);
}

/** A stored code row, as the verify logic needs it (pure — no DB types). */
export type CodeRecord = {
  code_hash: string;
  expires_at: string; // ISO
  attempts: number;
  consumed_at: string | null;
};

/** Why a code can't be used (or "ok"). Drives a GENERIC client response — the
 *  caller must NOT reveal which reason to the client (anti-enumeration). */
export type CodeState = "ok" | "expired" | "exhausted" | "consumed";

/** Pure: is this stored code usable right now? (before comparing the digits). */
export function codeUsable(rec: CodeRecord, nowMs: number): CodeState {
  if (rec.consumed_at) return "consumed";
  if (rec.attempts >= MAX_ATTEMPTS) return "exhausted";
  if (new Date(rec.expires_at).getTime() <= nowMs) return "expired";
  return "ok";
}

/** Pure: may we ISSUE a new code for this phone, given how many were created in
 *  the rate window? `recentCount` = rows for the phone with created_at within
 *  RATE_WINDOW_MS of now; `dailyCount` = the same within DAY_WINDOW_MS. */
export function mayIssue(recentCount: number, dailyCount = 0): boolean {
  return recentCount < MAX_CODES_PER_WINDOW && dailyCount < MAX_CODES_PER_DAY;
}

/** The expiry instant for a code created at `nowMs`, as an ISO string. */
export function expiryFrom(nowMs: number): string {
  return new Date(nowMs + CODE_TTL_MS).toISOString();
}

/* ------------------------------------------------------------ primitives */
// Mirrors wa-webhook/logic.ts (constant-time compare + hex helpers), on the
// Node side.

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

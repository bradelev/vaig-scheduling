// Invented data only. Exercises the request/verify ordering with fake ports.
import { describe, expect, it, vi } from "vitest";
import { requestCode, verifyCode, type OtpPorts } from "./flow";
import {
  hashCode,
  expiryFrom,
  DAY_WINDOW_MS,
  MAX_ATTEMPTS,
  MAX_CODES_PER_DAY,
  RATE_WINDOW_MS,
} from "./otp";

const PHONE = "+59891234567";
const PEPPER = "test-pepper";
const NOW = new Date("2026-09-01T12:00:00Z").getTime();

/** A configurable fake port set; override pieces per test. */
function ports(over: Partial<OtpPorts> = {}): OtpPorts {
  return {
    recentCodeCount: vi.fn(async () => 0),
    insertCode: vi.fn(async () => {}),
    sendCode: vi.fn(async () => {}),
    activeCode: vi.fn(async () => null),
    bumpAttempts: vi.fn(async () => 1 as number | null),
    consumeCode: vi.fn(async () => {}),
    establishSession: vi.fn(async () => {}),
    pepper: PEPPER,
    nowMs: NOW,
    rateWindowMs: RATE_WINDOW_MS,
    ...over,
  };
}

describe("requestCode", () => {
  it("issues: generates, stores, and sends a code", async () => {
    const p = ports();
    const res = await requestCode(PHONE, p);
    expect(res).toEqual({ ok: true });
    expect(p.insertCode).toHaveBeenCalledOnce();
    expect(p.sendCode).toHaveBeenCalledOnce();
    // The stored hash and the sent code correspond (same phone+pepper).
    const insertArg = (p.insertCode as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const sentCode = (p.sendCode as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(sentCode).toMatch(/^\d{6}$/);
    expect(insertArg.codeHash).toBe(await hashCode(PHONE, sentCode, PEPPER));
    expect(insertArg.phone).toBe(PHONE);
  });

  it("rate-limits: at the cap, does not issue or send", async () => {
    const p = ports({ recentCodeCount: vi.fn(async () => 3) });
    const res = await requestCode(PHONE, p);
    expect(res).toEqual({ ok: false, reason: "rate_limited" });
    expect(p.insertCode).not.toHaveBeenCalled();
    expect(p.sendCode).not.toHaveBeenCalled();
  });

  it("rate-limits at the DAILY cap even when the 15-minute window is clear", async () => {
    const p = ports({
      recentCodeCount: vi.fn(async (_phone: string, sinceMs: number) =>
        sinceMs === NOW - DAY_WINDOW_MS ? MAX_CODES_PER_DAY : 0,
      ),
    });
    const res = await requestCode(PHONE, p);
    expect(res).toEqual({ ok: false, reason: "rate_limited" });
    expect(p.sendCode).not.toHaveBeenCalled();
  });

  it("does NOT signal whether the phone is a known client (anti-enumeration)", async () => {
    // The flow has no port that checks client existence at request time — proof
    // by construction. Both a 'known' and 'unknown' phone take the same path.
    const p = ports();
    const res = await requestCode("+59899999999", p);
    expect(res).toEqual({ ok: true });
  });
});

describe("verifyCode", () => {
  async function activeRec(code: string, over: Partial<{ attempts: number; expires_at: string; consumed_at: string | null }> = {}) {
    return {
      id: "code-1",
      code_hash: await hashCode(PHONE, code, PEPPER),
      expires_at: expiryFrom(NOW),
      attempts: 0,
      consumed_at: null,
      ...over,
    };
  }

  it("accepts the correct code: bumps attempt, consumes, establishes session", async () => {
    const rec = await activeRec("123456");
    const p = ports({ activeCode: vi.fn(async () => rec) });
    const res = await verifyCode(PHONE, "123456", p);
    expect(res).toEqual({ ok: true });
    expect(p.bumpAttempts).toHaveBeenCalledWith("code-1");
    expect(p.consumeCode).toHaveBeenCalledWith("code-1");
    expect(p.establishSession).toHaveBeenCalledWith(PHONE);
  });

  it("rejects a wrong code but STILL burns an attempt", async () => {
    const rec = await activeRec("123456");
    const p = ports({ activeCode: vi.fn(async () => rec) });
    const res = await verifyCode(PHONE, "000000", p);
    expect(res).toEqual({ ok: false });
    expect(p.bumpAttempts).toHaveBeenCalledWith("code-1"); // attempt burned
    expect(p.consumeCode).not.toHaveBeenCalled();
    expect(p.establishSession).not.toHaveBeenCalled();
  });

  it("returns generic failure when there's no active code", async () => {
    const p = ports({ activeCode: vi.fn(async () => null) });
    expect(await verifyCode(PHONE, "123456", p)).toEqual({ ok: false });
    expect(p.bumpAttempts).not.toHaveBeenCalled();
  });

  it("rejects an expired code without burning an attempt (already dead)", async () => {
    const rec = await activeRec("123456", { expires_at: new Date(NOW - 1).toISOString() });
    const p = ports({ activeCode: vi.fn(async () => rec) });
    expect(await verifyCode(PHONE, "123456", p)).toEqual({ ok: false });
    expect(p.bumpAttempts).not.toHaveBeenCalled();
  });

  it("rejects an exhausted code", async () => {
    const rec = await activeRec("123456", { attempts: MAX_ATTEMPTS });
    const p = ports({ activeCode: vi.fn(async () => rec) });
    expect(await verifyCode(PHONE, "123456", p)).toEqual({ ok: false });
  });

  it("fails when the atomic bump returns null (cap hit under concurrency)", async () => {
    const rec = await activeRec("123456");
    // Snapshot said usable, but the conditional bump found the row already at
    // the cap (a concurrent request got the last attempt) → null → fail, and we
    // never compare or establish a session.
    const p = ports({
      activeCode: vi.fn(async () => rec),
      bumpAttempts: vi.fn(async () => null),
    });
    const res = await verifyCode(PHONE, "123456", p);
    expect(res).toEqual({ ok: false });
    expect(p.establishSession).not.toHaveBeenCalled();
  });

  it("rejects a consumed code (single-use)", async () => {
    const rec = await activeRec("123456", { consumed_at: new Date(NOW).toISOString() });
    const p = ports({ activeCode: vi.fn(async () => rec) });
    expect(await verifyCode(PHONE, "123456", p)).toEqual({ ok: false });
    expect(p.establishSession).not.toHaveBeenCalled();
  });

  it("rejects the right code for the WRONG phone (hash is phone-bound)", async () => {
    const rec = await activeRec("123456"); // hashed for PHONE
    const p = ports({ activeCode: vi.fn(async () => rec) });
    const res = await verifyCode("+59899999999", "123456", p);
    expect(res).toEqual({ ok: false });
  });
});

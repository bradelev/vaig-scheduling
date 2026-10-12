// Invented data only. Phones use the fixture E.164 format.
import { describe, expect, it } from "vitest";
import {
  generateCode,
  hashCode,
  verifyCodeHash,
  codeUsable,
  mayIssue,
  expiryFrom,
  CODE_LENGTH,
  MAX_ATTEMPTS,
  MAX_CODES_PER_WINDOW,
  CODE_TTL_MS,
  type CodeRecord,
} from "./otp";

const PHONE = "+59891234567";
const PEPPER = "test-pepper-not-a-real-secret";

describe("generateCode", () => {
  it("returns a zero-padded string of the requested length, digits only", () => {
    for (let i = 0; i < 200; i++) {
      const c = generateCode();
      expect(c).toHaveLength(CODE_LENGTH);
      expect(c).toMatch(/^\d+$/);
    }
  });

  it("produces varied values (not a constant)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateCode());
    // With 10^6 space and 100 draws, essentially always many distinct values.
    expect(seen.size).toBeGreaterThan(90);
  });

  it("can produce codes with leading zeros (padding works)", () => {
    // Force short length to make leading-zero codes common, prove padding.
    const codes = Array.from({ length: 300 }, () => generateCode(2));
    expect(codes.every((c) => c.length === 2)).toBe(true);
    expect(codes.some((c) => c.startsWith("0"))).toBe(true);
  });

  it("rejects out-of-range lengths", () => {
    expect(() => generateCode(0)).toThrow();
    expect(() => generateCode(10)).toThrow();
  });
});

describe("hashCode / verifyCodeHash", () => {
  it("is deterministic for the same phone+code+pepper", async () => {
    const h1 = await hashCode(PHONE, "123456", PEPPER);
    const h2 = await hashCode(PHONE, "123456", PEPPER);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });

  it("binds to the phone (same code, different phone → different hash)", async () => {
    const a = await hashCode(PHONE, "123456", PEPPER);
    const b = await hashCode("+59899999999", "123456", PEPPER);
    expect(a).not.toBe(b);
  });

  it("binds to the pepper (a leaked hash is useless without it)", async () => {
    const a = await hashCode(PHONE, "123456", PEPPER);
    const b = await hashCode(PHONE, "123456", "different-pepper");
    expect(a).not.toBe(b);
  });

  it("verifies the correct code and rejects a wrong one", async () => {
    const stored = await hashCode(PHONE, "123456", PEPPER);
    expect(await verifyCodeHash(PHONE, "123456", stored, PEPPER)).toBe(true);
    expect(await verifyCodeHash(PHONE, "123457", stored, PEPPER)).toBe(false);
  });

  it("rejects a code for a different phone even if digits match", async () => {
    const stored = await hashCode(PHONE, "123456", PEPPER);
    expect(await verifyCodeHash("+59899999999", "123456", stored, PEPPER)).toBe(false);
  });

  it("rejects a malformed stored hash without throwing", async () => {
    expect(await verifyCodeHash(PHONE, "123456", "not-hex", PEPPER)).toBe(false);
    expect(await verifyCodeHash(PHONE, "123456", "abc", PEPPER)).toBe(false);
  });

  it("throws if the pepper is missing (fail loud, never hash without it)", async () => {
    await expect(hashCode(PHONE, "123456", "")).rejects.toThrow();
  });
});

describe("codeUsable", () => {
  const now = new Date("2026-09-01T12:00:00Z").getTime();
  const base: CodeRecord = {
    code_hash: "x",
    expires_at: new Date(now + 60_000).toISOString(),
    attempts: 0,
    consumed_at: null,
  };

  it("ok when fresh, unused, attempts under the cap", () => {
    expect(codeUsable(base, now)).toBe("ok");
  });
  it("consumed once used (single-use)", () => {
    expect(codeUsable({ ...base, consumed_at: new Date(now).toISOString() }, now)).toBe("consumed");
  });
  it("exhausted at the attempt cap", () => {
    expect(codeUsable({ ...base, attempts: MAX_ATTEMPTS }, now)).toBe("exhausted");
  });
  it("expired at or past expires_at", () => {
    const expired = { ...base, expires_at: new Date(now).toISOString() };
    expect(codeUsable(expired, now)).toBe("expired");
  });
  it("consumed takes priority over expired/exhausted", () => {
    const dead = {
      code_hash: "x",
      expires_at: new Date(now - 1).toISOString(),
      attempts: MAX_ATTEMPTS,
      consumed_at: new Date(now).toISOString(),
    };
    expect(codeUsable(dead, now)).toBe("consumed");
  });
});

describe("mayIssue (rate limit)", () => {
  it("allows under the cap, blocks at and over it", () => {
    expect(mayIssue(0)).toBe(true);
    expect(mayIssue(MAX_CODES_PER_WINDOW - 1)).toBe(true);
    expect(mayIssue(MAX_CODES_PER_WINDOW)).toBe(false);
    expect(mayIssue(MAX_CODES_PER_WINDOW + 5)).toBe(false);
  });
});

describe("expiryFrom", () => {
  it("is TTL after now", () => {
    const now = new Date("2026-09-01T12:00:00Z").getTime();
    expect(expiryFrom(now)).toBe(new Date(now + CODE_TTL_MS).toISOString());
  });
});

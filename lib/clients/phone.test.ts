import { describe, expect, it } from "vitest";
import { normalizePhoneIntl } from "./phone";
import { normalizePhone } from "../normalize";

describe("normalizePhoneIntl — Uruguayan numbers stay identical to the old normalizer", () => {
  // These must produce the SAME E.164 as lib/normalize.ts's normalizePhone, or
  // existing UY clients wouldn't match (Deno sync still uses the old one).
  const uyCases = [
    "091234567",
    "099123456",
    "91234567",
    "59891234567",
    "+598 91 234 567",
    "099-123-456",
    "(099) 123.456",
    // Landlines — all three prefixes the old normalizer accepts (2, 3, 4).
    // The `3` case is the regression the reviewer caught: libphonenumber alone
    // rejects it (not in UY's official plan), but our data has them, so the
    // Uruguay-first order must keep accepting it identically.
    "24001234", // Montevideo landline (2)
    "31733433", // interior landline (3) — must NOT be rejected
    "47221234", // interior landline (4)
  ];
  for (const input of uyCases) {
    it(`"${input}" matches the Uruguay-only normalizer`, () => {
      const old = normalizePhone(input);
      expect(old).not.toBeNull(); // sanity: the old one accepts it
      expect(normalizePhoneIntl(input)).toBe(old);
    });
  }
});

describe("normalizePhoneIntl — accepts international numbers (the bug fix)", () => {
  it("USA (+1)", () => {
    // A real, valid US number format.
    expect(normalizePhoneIntl("+1 415 555 0132")).toBe("+14155550132");
  });
  it("Spain (+34)", () => {
    expect(normalizePhoneIntl("+34 612 34 56 78")).toBe("+34612345678");
  });
  it("India (+91)", () => {
    expect(normalizePhoneIntl("+91 98765 43210")).toBe("+919876543210");
  });
  it("Argentina (+54) — previously rejected, now accepted", () => {
    // The old normalizer returned null for this (normalize.test.ts line 44).
    expect(normalizePhone("+54 9 11 1234 5678")).toBeNull();
    expect(normalizePhoneIntl("+54 9 11 1234 5678")).toBe("+5491112345678");
  });
});

describe("normalizePhoneIntl — still rejects garbage", () => {
  it("empty / non-phone / too short", () => {
    expect(normalizePhoneIntl("")).toBeNull();
    expect(normalizePhoneIntl("   ")).toBeNull();
    expect(normalizePhoneIntl("sin telefono")).toBeNull();
    expect(normalizePhoneIntl("1234567")).toBeNull(); // too short for UY
  });
  it("a bare short number is assumed UY and validated (invalid → null)", () => {
    // 51234567: 8 digits starting with 5 — not a valid UY mobile/landline.
    expect(normalizePhoneIntl("51234567")).toBeNull();
  });
});

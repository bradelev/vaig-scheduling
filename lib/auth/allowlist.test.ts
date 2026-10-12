import { describe, expect, it } from "vitest";
import { isStaffEmail, parseStaffEmails } from "./allowlist";

// Invented addresses only (CLAUDE.md sensitive-data rule).
const RAW = "ana@example.com, Bea@Example.com ,, carla@example.com,";

describe("parseStaffEmails", () => {
  it("splits, trims, lowercases and drops empty entries", () => {
    expect(parseStaffEmails(RAW)).toEqual(
      new Set(["ana@example.com", "bea@example.com", "carla@example.com"]),
    );
  });

  it("returns an empty set for undefined or blank env", () => {
    expect(parseStaffEmails(undefined).size).toBe(0);
    expect(parseStaffEmails("").size).toBe(0);
    expect(parseStaffEmails(" , ,").size).toBe(0);
  });
});

describe("isStaffEmail", () => {
  it("accepts allowlisted emails case-insensitively", () => {
    expect(isStaffEmail("ana@example.com", RAW)).toBe(true);
    expect(isStaffEmail("BEA@EXAMPLE.COM", RAW)).toBe(true);
    expect(isStaffEmail("  carla@example.com  ", RAW)).toBe(true);
  });

  it("rejects emails outside the allowlist", () => {
    expect(isStaffEmail("outsider@example.com", RAW)).toBe(false);
    // Substrings or lookalike domains must not slip through.
    expect(isStaffEmail("ana@example.com.evil.io", RAW)).toBe(false);
    expect(isStaffEmail("na@example.com", RAW)).toBe(false);
    // Plus-addressing is a different mailbox owner as far as auth is
    // concerned: exact match only.
    expect(isStaffEmail("ana+x@example.com", RAW)).toBe(false);
  });

  it("rejects everyone when the allowlist is missing or empty (secure default)", () => {
    expect(isStaffEmail("ana@example.com", undefined)).toBe(false);
    expect(isStaffEmail("ana@example.com", "")).toBe(false);
  });

  it("rejects null/undefined/empty email", () => {
    expect(isStaffEmail(null, RAW)).toBe(false);
    expect(isStaffEmail(undefined, RAW)).toBe(false);
    expect(isStaffEmail("", RAW)).toBe(false);
  });
});

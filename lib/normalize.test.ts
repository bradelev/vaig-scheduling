import { describe, expect, it } from "vitest";
import {
  EMPLOYEES,
  NON_SESSION_PATTERNS,
  normalizePhone,
  normalizeText,
  tokens,
} from "./normalize";

// All phone numbers below are invented, with a real Uruguayan format
// (CLAUDE.md sensitive-data rule).

describe("normalizePhone", () => {
  it("normalizes 9-digit local mobiles with leading 0", () => {
    expect(normalizePhone("091234567")).toBe("+59891234567");
    expect(normalizePhone("099123456")).toBe("+59899123456");
  });

  it("normalizes 8-digit mobiles without the leading 0", () => {
    expect(normalizePhone("91234567")).toBe("+59891234567");
  });

  it("normalizes numbers already prefixed with 598", () => {
    expect(normalizePhone("59891234567")).toBe("+59891234567");
    expect(normalizePhone("+598 91 234 567")).toBe("+59891234567");
  });

  it("normalizes 8-digit landlines starting 2-4", () => {
    expect(normalizePhone("24001234")).toBe("+59824001234");
    expect(normalizePhone("47221234")).toBe("+59847221234");
  });

  it("ignores separators and formatting noise", () => {
    expect(normalizePhone("099-123-456")).toBe("+59899123456");
    expect(normalizePhone("(099) 123.456")).toBe("+59899123456");
    expect(normalizePhone("tel: 099 123 456")).toBe("+59899123456");
  });

  it("rejects anything that is not unambiguously Uruguayan", () => {
    expect(normalizePhone("1234567")).toBeNull(); // too short
    expect(normalizePhone("51234567")).toBeNull(); // 8 digits, invalid leading 5
    expect(normalizePhone("0991234567")).toBeNull(); // 10 digits, no rule
    expect(normalizePhone("59851234567")).toBeNull(); // 598 + invalid national part
    expect(normalizePhone("+54 911 1234 5678")).toBeNull(); // Argentina
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("sin telefono")).toBeNull();
  });
});

describe("normalizeText", () => {
  it("lowercases and strips diacritics", () => {
    expect(normalizeText("Sesión de Depilación Láser")).toBe(
      "sesion de depilacion laser",
    );
  });

  it("folds ñ to n via NFD", () => {
    expect(normalizeText("Uñas")).toBe("unas");
  });

  it("strips punctuation and collapses whitespace", () => {
    expect(normalizeText("External - Cita con María Pérez [099123456]")).toBe(
      "external cita con maria perez 099123456",
    );
    expect(normalizeText("  lu   no  (consultar)  ")).toBe("lu no consultar");
  });

  it("returns empty string for empty or punctuation-only input", () => {
    expect(normalizeText("")).toBe("");
    expect(normalizeText("¿¡·—!")).toBe("");
  });
});

describe("tokens", () => {
  it("drops numeric tokens", () => {
    expect(tokens("María 15:30")).toEqual(["maria"]);
    expect(tokens("099123456")).toEqual([]);
  });

  it("drops service stopwords in their normalized form", () => {
    expect(tokens("Masaje María")).toEqual(["maria"]);
    expect(tokens("Uñas manos y pies")).toEqual(["y"]);
  });

  it("drops employee names so they are never learned as aliases (§7.1)", () => {
    expect(tokens("Uñas step")).toEqual([]);
    expect(tokens("cyn limpieza facial")).toEqual([]);
  });

  it("keeps client-identifying tokens from a real-shaped title", () => {
    expect(tokens("Cita con María Pérez [099 123 456]")).toEqual([
      "con",
      "maria",
      "perez",
    ]);
  });

  it("returns [] for empty input", () => {
    expect(tokens("")).toEqual([]);
    expect(tokens("   ")).toEqual([]);
  });
});

describe("§7.0 classification constants", () => {
  it("EMPLOYEES covers the names and nicknames seen in the real calendar", () => {
    for (const name of ["cyn", "lu", "iara", "steph", "stephy"]) {
      expect(EMPLOYEES).toContain(name);
    }
  });

  it("NON_SESSION_PATTERNS match normalized real admin titles", () => {
    const matches = (title: string) =>
      NON_SESSION_PATTERNS.some((p) => p.test(normalizeText(title)));
    expect(matches("BPS trámite")).toBe(true);
    expect(matches("Pagar alquiler")).toBe(true);
    expect(matches("Lista de compras")).toBe(true);
    expect(matches("ver si viene la clienta")).toBe(true);
    expect(matches("Mandar recordatorios")).toBe(true);
    expect(matches("Feriado no laborable")).toBe(true);
    expect(matches("Cardióloga 15hs")).toBe(true);
    // Real sessions must NOT match.
    expect(matches("External - Cita con María Pérez")).toBe(false);
    expect(matches("Masaje descontracturante Ana")).toBe(false);
  });

  it("NON_SESSION_PATTERNS discard bills/dues but not payment notes in sessions", () => {
    const matches = (title: string) =>
      NON_SESSION_PATTERNS.some((p) => p.test(normalizeText(title)));
    // Real queue evidence (issue #48), invented org names kept generic.
    expect(matches("FACTURA GANISOL (MDEO COMM) VENCE EL 10")).toBe(true);
    expect(matches("VENCE UTE")).toBe(true);
    // A client session with a payment note mid-title must NOT match
    // (invented names; the pattern shapes mirror real queue titles).
    expect(matches("Carla Sotelo rostro 20% off mas 10% transf")).toBe(false);
    expect(matches("Tamara bk y bz x sesion (ya pagó)")).toBe(false);
  });

  it("NON_SESSION_PATTERNS discard employee shift blocks", () => {
    const matches = (title: string) =>
      NON_SESSION_PATTERNS.some((p) => p.test(normalizeText(title)));
    expect(matches("Iara de 7:30 a 16:30 (9)")).toBe(true);
    expect(matches("Lu de 13 a 20:30 (7,5)")).toBe(true);
    expect(matches("cyn de 9 a 18")).toBe(true);
    // A client whose name merely starts like an employee is NOT a shift.
    expect(matches("Iara Machado lifting")).toBe(false);
    expect(matches("iara de belén masaje")).toBe(false);
  });
});

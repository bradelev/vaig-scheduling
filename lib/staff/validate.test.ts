// Invented data only.
import { describe, expect, it } from "vitest";
import { CALENDAR_COLORS, staffSlug, validatePriority, validateStaffDraft } from "./validate";

describe("staffSlug", () => {
  it("lowercases, strips accents, keeps only [a-z0-9]", () => {
    expect(staffSlug("María José")).toBe("mariajose");
    expect(staffSlug("Lu")).toBe("lu");
    expect(staffSlug("  ")).toBe("");
    expect(staffSlug("Ñandú 7")).toBe("nandu7");
  });
});

describe("validateStaffDraft", () => {
  it("accepts a full draft, normalizing an already-international phone", () => {
    expect(
      validateStaffDraft({ name: "  Ana Prueba  ", phone: "+59891234567", colorId: "3" }),
    ).toEqual({
      ok: true,
      draft: { name: "Ana Prueba", phone: "+59891234567", colorId: 3 },
    });
  });

  it("normalizes a local-format phone (099 123 456 -> +59899123456)", () => {
    // normalizePhoneIntl tries the Uruguay-only normalizer first: digits
    // "099123456" (9 digits, leading "09") -> "+598" + "99123456".
    expect(validateStaffDraft({ name: "Ana Prueba", phone: "099 123 456" })).toEqual({
      ok: true,
      draft: { name: "Ana Prueba", phone: "+59899123456", colorId: null },
    });
  });

  it("empty phone -> null, no error", () => {
    expect(validateStaffDraft({ name: "Ana Prueba", phone: "" })).toEqual({
      ok: true,
      draft: { name: "Ana Prueba", phone: null, colorId: null },
    });
  });

  it("rejects an invalid phone", () => {
    expect(validateStaffDraft({ name: "Ana Prueba", phone: "123" })).toEqual({
      error: "El teléfono no es válido (formato +598…).",
    });
  });

  it("rejects an empty name", () => {
    expect(validateStaffDraft({ name: "  " })).toEqual({ error: "El nombre no puede estar vacío." });
  });

  it("rejects a name over 60 chars", () => {
    expect(validateStaffDraft({ name: "a".repeat(61) })).toEqual({
      error: "El nombre es demasiado largo (máximo 60 caracteres).",
    });
  });

  it("rejects colorId 0", () => {
    expect(validateStaffDraft({ name: "Ana Prueba", colorId: 0 })).toEqual({ error: "El color no es válido." });
  });

  it("rejects colorId 12", () => {
    expect(validateStaffDraft({ name: "Ana Prueba", colorId: 12 })).toEqual({ error: "El color no es válido." });
  });
});

describe("validatePriority", () => {
  it("accepts 1..999", () => {
    expect(validatePriority(1)).toEqual({ ok: true, priority: 1 });
    expect(validatePriority(999)).toEqual({ ok: true, priority: 999 });
    expect(validatePriority("50")).toEqual({ ok: true, priority: 50 });
  });

  it("rejects 0 and 1000", () => {
    expect(validatePriority(0)).toEqual({ error: "La prioridad debe ser un número entre 1 y 999." });
    expect(validatePriority(1000)).toEqual({ error: "La prioridad debe ser un número entre 1 y 999." });
  });

  it("rejects a non-integer", () => {
    expect(validatePriority(1.5)).toEqual({ error: "La prioridad debe ser un número entre 1 y 999." });
  });
});

describe("CALENDAR_COLORS", () => {
  it("has all 11 Google Calendar colors", () => {
    expect(CALENDAR_COLORS).toHaveLength(11);
    expect(CALENDAR_COLORS[0]).toEqual({ id: 1, label: "Lavanda", hex: "#7986cb" });
    expect(CALENDAR_COLORS[10]).toEqual({ id: 11, label: "Tomate", hex: "#d60000" });
  });
});

import { describe, expect, it } from "vitest";
import { validateServiceDraft } from "./validate";

describe("validateServiceDraft", () => {
  it("accepts a full draft, coercing string numbers", () => {
    expect(
      validateServiceDraft({
        name: "  Depilación láser  ",
        category: "  Depilación  ",
        durationMin: "45",
        priceUyu: "1950",
        packageSessions: "6",
      }),
    ).toEqual({
      ok: true,
      draft: {
        name: "Depilación láser",
        category: "Depilación",
        durationMin: 45,
        priceUyu: 1950,
        packageSessions: 6,
      },
    });
  });

  it("accepts a minimal draft: empty category -> null, no price -> 'a consultar', no sessions -> normal", () => {
    expect(
      validateServiceDraft({ name: "Masaje", category: "  ", durationMin: 60, priceUyu: null, packageSessions: null }),
    ).toEqual({
      ok: true,
      draft: { name: "Masaje", category: null, durationMin: 60, priceUyu: null, packageSessions: null },
    });
  });

  it("rejects an empty name", () => {
    expect(validateServiceDraft({ name: "  ", durationMin: 60 })).toEqual({
      error: "El nombre no puede estar vacío.",
    });
  });

  it("rejects a name over 120 chars", () => {
    expect(validateServiceDraft({ name: "a".repeat(121), durationMin: 60 })).toEqual({
      error: "El nombre es demasiado largo (máximo 120 caracteres).",
    });
  });

  it("rejects a duration below 5", () => {
    expect(validateServiceDraft({ name: "Masaje", durationMin: 4 })).toEqual({
      error: "La duración debe ser entre 5 y 480 minutos.",
    });
  });

  it("rejects a duration above 480", () => {
    expect(validateServiceDraft({ name: "Masaje", durationMin: 481 })).toEqual({
      error: "La duración debe ser entre 5 y 480 minutos.",
    });
  });

  it("rejects a non-integer duration", () => {
    expect(validateServiceDraft({ name: "Masaje", durationMin: 45.5 })).toEqual({
      error: "La duración debe ser entre 5 y 480 minutos.",
    });
  });

  it("rejects a negative price", () => {
    expect(validateServiceDraft({ name: "Masaje", durationMin: 60, priceUyu: -1 })).toEqual({
      error: "El precio no es válido.",
    });
  });

  it("rejects a price over 1,000,000", () => {
    expect(validateServiceDraft({ name: "Masaje", durationMin: 60, priceUyu: 1_000_001 })).toEqual({
      error: "El precio no es válido.",
    });
  });

  it("rejects packageSessions of 1 (below the 2..60 range)", () => {
    expect(validateServiceDraft({ name: "Cuponera", durationMin: 60, packageSessions: 1 })).toEqual({
      error: "Una cuponera necesita entre 2 y 60 sesiones.",
    });
  });

  it("rejects packageSessions of 61 (above the 2..60 range)", () => {
    expect(validateServiceDraft({ name: "Cuponera", durationMin: 60, packageSessions: 61 })).toEqual({
      error: "Una cuponera necesita entre 2 y 60 sesiones.",
    });
  });

  it("trims category to null when blank", () => {
    const result = validateServiceDraft({ name: "Masaje", category: "   ", durationMin: 60 });
    expect(result).toMatchObject({ ok: true, draft: { category: null } });
  });
});

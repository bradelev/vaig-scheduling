import { describe, expect, it } from "vitest";
import { categoryToSlug, SERVICE_SLUGS } from "./service-category";

describe("categoryToSlug — ALL 20 real External categories map to service_types slugs", () => {
  const cases: [string, string | null][] = [
    ["Depilación Láser", "depilacion"],
    ["Cuponeras de Depilación Láser", "depilacion"],
    ["Hifu", "hifu"],
    ["Masaje Deportivo", "masaje"],
    ["Masaje Estético", "masaje"],
    ["Masaje Para Embarazadas", "masaje"],
    ["Masaje Revitalizante", "masaje"],
    ["Masaje Terapéutico", "masaje"],
    ["Servicios Faciales", "limpieza_facial"], // plural must still match
    ["Servicio de Manos / Pies", "unas"],
    // Ambiguous / unmapped → null (uncategorized, still a valid session).
    ["Aparatología", null],
    ["Day Spa", null],
    ["Electrodos", null],
    ["Lifting de pestañas", null],
    ["Nutrición ", null],
    ["Promociones", null],
    // "Piel" must NOT false-match "pie" → unas (the whole-word fix).
    ["Revitaliza tu Piel", null],
    ["Servicios Varios", null],
    ["Servicios para Cejas", null],
    ["Ultracavitador", null],
    // Not a External category today, but the slug's own word must map.
    ["Radiofrecuencia", "radiofrecuencia"],
    ["Uñas", "unas"],
  ];
  for (const [cat, slug] of cases) {
    it(`"${cat}" → ${slug ?? "null"}`, () => {
      expect(categoryToSlug(cat)).toBe(slug);
    });
  }

  it("null/empty category → null", () => {
    expect(categoryToSlug(null)).toBeNull();
    expect(categoryToSlug(undefined)).toBeNull();
    expect(categoryToSlug("")).toBeNull();
  });

  it("every mapped result is one of the 7 real slugs", () => {
    const mapped = ["Depilación Láser", "Hifu", "Masaje Estético", "Servicios Faciales", "Servicio de Manos / Pies"]
      .map(categoryToSlug)
      .filter((s): s is NonNullable<typeof s> => s !== null);
    for (const s of mapped) {
      expect(SERVICE_SLUGS).toContain(s);
    }
  });
});

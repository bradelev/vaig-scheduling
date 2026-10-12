import { describe, expect, it } from "vitest";
import { serviceLabel } from "./service-label";

describe("serviceLabel", () => {
  it("maps a catalog slug (app session) straight to its label", () => {
    expect(serviceLabel("depilacion")).toBe("Depilación");
    expect(serviceLabel("limpieza_facial")).toBe("Limpieza facial");
    expect(serviceLabel("hifu")).toBe("HIFU");
    expect(serviceLabel("unas")).toBe("Uñas");
  });

  it("generalizes messy External free text to the broad category", () => {
    expect(serviceLabel("depilación de bozo")).toBe("Depilación");
    expect(serviceLabel("Depilacion piernas completas")).toBe("Depilación");
    expect(serviceLabel("limpieza de cutis con hidratación de labios")).toBe(
      "Limpieza facial",
    );
    expect(serviceLabel("masaje descontracturante")).toBe("Masaje");
    expect(serviceLabel("maderoterapia")).toBe("Masaje");
  });

  it("is accent- and case-insensitive", () => {
    expect(serviceLabel("DEPILACIÓN")).toBe("Depilación");
    expect(serviceLabel("Facial")).toBe("Limpieza facial");
  });

  it("returns null for empty or nullish input", () => {
    expect(serviceLabel(null)).toBeNull();
    expect(serviceLabel(undefined)).toBeNull();
    expect(serviceLabel("")).toBeNull();
    expect(serviceLabel("   ")).toBeNull();
  });

  it("returns null for unrecognized free text (→ doubtful register)", () => {
    expect(serviceLabel("pe 3/8 cc y ax")).toBeNull();
    expect(serviceLabel("algo raro")).toBeNull();
  });

  it("does NOT mistake the article 'una' for the Uñas category (regression)", () => {
    // fold() must keep "uña" ≠ "una"; word-boundary matching must not fire
    // mid-word. These free-text notes are common in External calendar titles.
    expect(serviceLabel("una consulta")).toBeNull();
    expect(serviceLabel("control de una cicatriz")).toBeNull();
    expect(serviceLabel("reprogramar, había una duda")).toBeNull();
    expect(serviceLabel("fortuna")).toBeNull();
  });

  it("still recognizes real nail services (keeps the ñ words)", () => {
    expect(serviceLabel("uña encarnada")).toBe("Uñas");
    expect(serviceLabel("uñas esculpidas")).toBe("Uñas");
    expect(serviceLabel("manicuría")).toBe("Uñas");
    expect(serviceLabel("esmaltado semipermanente")).toBe("Uñas");
  });

  it("does not fire a stem mid-word (word-boundary matching)", () => {
    // "facial" is a Limpieza facial stem, but "superficial" must not match.
    expect(serviceLabel("superficial")).toBeNull();
  });
});

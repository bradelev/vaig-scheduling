import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIGNATURE,
  firstName,
  reactivationMessage,
  rebookWaLink,
  waLink,
} from "./walink";

// Fixed clock so {month} is deterministic: 2026-08-08 in Montevideo.
const NOW = new Date("2026-08-08T12:00:00-03:00");
// A session within the last 12 months (March 2026) → bare month "marzo".
const MARCH = "2026-03-10T15:00:00-03:00";

describe("firstName", () => {
  it("returns the first whitespace-separated token of the trimmed name", () => {
    expect(firstName("Ana Pérez López")).toBe("Ana");
    expect(firstName("  Ana   Pérez ")).toBe("Ana");
    expect(firstName("Ana")).toBe("Ana");
  });

  it("returns empty string for an empty or whitespace-only name", () => {
    expect(firstName("")).toBe("");
    expect(firstName("   ")).toBe("");
  });
});

describe("reactivationMessage — register selection", () => {
  const specifics = { service: "depilacion", lastSessionIso: MARCH, now: NOW };

  it("VERIFIED: both service and date known, not new", () => {
    const m = reactivationMessage("Ana Pérez", { ...specifics, signature: "Lu" });
    expect(m).toBe(
      "Hola Ana, soy Lu de VAIG. Estoy revisando la agenda y vi que tu última sesión de Depilación fue en marzo y no tenés ninguna reservada. Te agendo un turno estos días o preferís que te escriba más adelante?",
    );
  });

  it("NEW: adds the 'Entré hace poco y' lead when isNew", () => {
    const m = reactivationMessage("Ana", {
      ...specifics,
      signature: "Valentina",
      isNew: true,
    });
    expect(m).toContain("soy Valentina de VAIG. Entré hace poco y estoy revisando");
    expect(m).toContain("tu última sesión de Depilación fue en marzo");
  });

  it("DOUBTFUL when the service is missing — drops {service} and {month}", () => {
    const m = reactivationMessage("Ana", {
      service: null,
      lastSessionIso: MARCH,
      signature: "Lu",
      now: NOW,
    });
    expect(m).toBe(
      "Hola Ana, soy Lu de VAIG. Estoy revisando la agenda y vi que no tenés ninguna sesión reservada. Te agendo un turno estos días o preferís que te escriba más adelante?",
    );
    expect(m).not.toContain("{");
  });

  it("DOUBTFUL when the date is missing even if service is known", () => {
    const m = reactivationMessage("Ana", {
      service: "depilacion",
      lastSessionIso: null,
      signature: "Lu",
      now: NOW,
    });
    expect(m).toContain("no tenés ninguna sesión reservada");
    expect(m).not.toContain("Depilación");
    expect(m).not.toContain("{");
  });

  it("DOUBTFUL + new keeps the 'Entré hace poco y' lead", () => {
    const m = reactivationMessage("Ana", {
      service: null,
      lastSessionIso: null,
      isNew: true,
    });
    expect(m).toContain("Entré hace poco y estoy revisando la agenda.");
  });

  it("falls back to the default signature when none is given", () => {
    const m = reactivationMessage("Ana", specifics);
    expect(m).toContain(`soy ${DEFAULT_SIGNATURE} de VAIG`);
  });

  it("generalizes messy External free text (bozo → Depilación, not the zone)", () => {
    const m = reactivationMessage("Ana", {
      service: "depilación de bozo",
      lastSessionIso: MARCH,
      now: NOW,
    });
    expect(m).toContain("tu última sesión de Depilación fue en marzo");
    expect(m).not.toContain("bozo");
  });

  it("unrecognized service → doubtful (never sends a raw ugly value)", () => {
    const m = reactivationMessage("Ana", {
      service: "pe 3/8 cc y ax",
      lastSessionIso: MARCH,
      now: NOW,
    });
    expect(m).toContain("no tenés ninguna sesión reservada");
    expect(m).not.toContain("pe 3/8");
  });
});

describe("waLink", () => {
  it("strips every non-digit from the phone (wa.me wants no +)", () => {
    const link = waLink("+59891234567", "Ana Pérez");
    expect(link).toContain("wa.me/59891234567?text=");
  });

  it("URL-encodes the message and interpolates the first name only", () => {
    const link = waLink("+59891234567", "Ana Pérez López", {
      service: "depilacion",
      lastSessionIso: MARCH,
      now: NOW,
      signature: "Lu",
    });
    const decoded = decodeURIComponent(link.split("?text=")[1]);
    expect(decoded).toBe(
      reactivationMessage("Ana Pérez López", {
        service: "depilacion",
        lastSessionIso: MARCH,
        now: NOW,
        signature: "Lu",
      }),
    );
    expect(decoded.startsWith("Hola Ana,")).toBe(true);
  });

  it("collapses any doubled space left by an empty name", () => {
    const link = waLink("+59891234567", "");
    const decoded = decodeURIComponent(link.split("?text=")[1]);
    expect(decoded).not.toContain("  ");
    expect(decoded).not.toMatch(/\s[,.]/);
  });
});

describe("rebookWaLink (issue #107)", () => {
  it("builds a wa.me link with the first name and no leading +", () => {
    const link = rebookWaLink("+59891234567", "Lucía González");
    expect(link.startsWith("https://wa.me/59891234567?text=")).toBe(true);
    const decoded = decodeURIComponent(link.split("?text=")[1]);
    expect(decoded).toContain("¡Hola Lucía!");
    expect(decoded).toContain("próxima sesión");
  });

  it("collapses the gap left by an empty name", () => {
    const decoded = decodeURIComponent(
      rebookWaLink("+59891234567", "").split("?text=")[1],
    );
    expect(decoded).not.toContain("¡Hola !");
    expect(decoded.startsWith("¡Hola!")).toBe(true);
  });
});

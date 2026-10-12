import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyReservationConfirmed, prepInstructionFor } from "./notify-client";

describe("prepInstructionFor — by the booked item's category", () => {
  it("depilación → shave the day before", () => {
    expect(prepInstructionFor("Depilación Láser")).toMatch(/rasurada/);
    expect(prepInstructionFor("Cuponeras de Depilación Láser")).toMatch(/rasurada/);
  });
  it("facial / cejas / pestañas → no makeup", () => {
    expect(prepInstructionFor("Servicios Faciales")).toBe("Vení sin maquillaje.");
    expect(prepInstructionFor("Servicios para Cejas")).toBe("Vení sin maquillaje.");
    expect(prepInstructionFor("Lifting de pestañas")).toBe("Vení sin maquillaje.");
  });
  it("anything else (masajes, day spa, null) → nothing special, never empty", () => {
    for (const c of ["Masaje Estético", "Day Spa", null]) {
      const s = prepInstructionFor(c);
      expect(s.length).toBeGreaterThan(0);
      expect(s).toMatch(/preparación especial/);
    }
  });
});

describe("notifyReservationConfirmed (stub mode)", () => {
  const OLD_ENV = process.env.CLIENT_AUTH_TEST_MODE;
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    process.env.CLIENT_AUTH_TEST_MODE = "1"; // never hit Meta
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.CLIENT_AUTH_TEST_MODE;
    else process.env.CLIENT_AUTH_TEST_MODE = OLD_ENV;
    info.mockRestore();
  });

  it("logs the 4 params in template order with last-4 of the phone only", async () => {
    await notifyReservationConfirmed({
      clientPhone: "+59891234567",
      clientName: "Ana Prueba",
      serviceName: "Pierna entera",
      category: "Depilación Láser",
      startsAt: "2026-09-07T17:00:00.000Z",
    });
    const line = String(info.mock.calls[0][0]);
    expect(line).toContain("...4567");
    expect(line).not.toContain("91234567");
    expect(line).toContain(
      "Ana Prueba | Pierna entera | lunes 7/9 a las 14:00 | Vení con la zona rasurada del día anterior.",
    );
  });

  it("falls back to a neutral word when the client has no name", async () => {
    await notifyReservationConfirmed({
      clientPhone: "+59891234567",
      clientName: null,
      serviceName: "Masaje relax",
      category: "Masaje Estético",
      startsAt: "2026-09-07T17:00:00.000Z",
    });
    expect(String(info.mock.calls[0][0])).toContain("clienta | Masaje relax");
  });
});

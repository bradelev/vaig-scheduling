/**
 * Unit tests for the 🔁 wa.me quick action (issue #62). Invented data only.
 */
import { describe, expect, it } from "vitest";
import { reschedWaLink, reschedWhenLabel } from "./resched-link";

describe("reschedWhenLabel", () => {
  it("renders Montevideo local time with manual zero-padding", () => {
    // 20:30Z = 17:30 in Montevideo (UTC-3, no DST since 2015)
    expect(reschedWhenLabel("2026-07-22T20:30:00Z")).toBe("22/07 a las 17:30");
  });

  it("pads single-digit day/month/hour", () => {
    // 11:05Z = 08:05 in Montevideo
    expect(reschedWhenLabel("2026-08-03T11:05:00Z")).toBe("03/08 a las 08:05");
  });
});

describe("reschedWaLink", () => {
  it("strips the + and prefills the full message", () => {
    const url = reschedWaLink(
      "+59891234567",
      "Valentina Inventada",
      "2026-07-22T20:30:00Z",
    );
    expect(url.startsWith("https://wa.me/59891234567?text=")).toBe(true);
    const text = decodeURIComponent(url.split("?text=")[1]);
    expect(text).toBe(
      "¡Hola Valentina! Vimos que pediste reagendar tu sesión del 22/07 a las 17:30. ¿Qué horario te queda bien?",
    );
  });

  it("collapses the gap left by an empty name", () => {
    const url = reschedWaLink("+59891234567", "  ", "2026-07-22T20:30:00Z");
    const text = decodeURIComponent(url.split("?text=")[1]);
    expect(text.startsWith("¡Hola! Vimos")).toBe(true);
  });
});

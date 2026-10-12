/**
 * Unit tests for the canonical wa.me link builder (R4 consolidation).
 * Invented data only.
 */
import { describe, expect, it } from "vitest";
import { cleanWaMessage, waMeLink } from "./walink";

describe("cleanWaMessage", () => {
  it("collapses a space before punctuation (¡Hola ! → ¡Hola!)", () => {
    expect(cleanWaMessage("¡Hola ! ")).toBe("¡Hola!");
  });

  it("collapses doubled spaces", () => {
    expect(cleanWaMessage("Hello  world")).toBe("Hello world");
    expect(cleanWaMessage("¡Hola  mundo!")).toBe("¡Hola mundo!");
  });

  it("trims leading and trailing whitespace", () => {
    expect(cleanWaMessage("  ¡Hola!  ")).toBe("¡Hola!");
  });

  it("leaves already-clean text unchanged", () => {
    expect(cleanWaMessage("¡Hola mundo!")).toBe("¡Hola mundo!");
  });

  it("handles multiple punctuation and spaces", () => {
    expect(cleanWaMessage("Hello ,  world !  .")).toBe("Hello, world!.");
  });
});

describe("waMeLink", () => {
  it("strips + and spaces from a phone like +598 91 234 567", () => {
    const link = waMeLink("+598 91 234 567", "Hello");
    expect(link.startsWith("https://wa.me/59891234567?text=")).toBe(true);
  });

  it("URL-encodes the message", () => {
    const link = waMeLink("+59891234567", "¡Hola!");
    const encoded = link.split("?text=")[1];
    expect(encoded).toBe(encodeURIComponent("¡Hola!"));
  });

  it("runs the message through cleanWaMessage (¡Hola ! → ¡Hola!)", () => {
    const link = waMeLink("+59891234567", "¡Hola ! world");
    const encoded = link.split("?text=")[1];
    const decoded = decodeURIComponent(encoded);
    expect(decoded).toBe("¡Hola! world");
  });

  it("strips every non-digit from the phone", () => {
    const link = waMeLink("+598-91-234-567", "Hi");
    expect(link).toContain("wa.me/59891234567?text=");
  });

  it("combines digit stripping and message cleanup correctly", () => {
    const link = waMeLink("+598 91 234 567", "¡Hola ! there");
    expect(link.startsWith("https://wa.me/59891234567?text=")).toBe(true);
    const decoded = decodeURIComponent(link.split("?text=")[1]);
    expect(decoded).toBe("¡Hola! there");
  });
});

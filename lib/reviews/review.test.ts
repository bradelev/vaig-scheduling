import { describe, expect, it } from "vitest";
import {
  GOOGLE_REVIEW_URL,
  REVIEW_MIN_SESSIONS,
  reviewMessage,
  reviewWaLink,
} from "./review";

describe("reviewMessage", () => {
  it("interpolates the first name into the approved template body", () => {
    const m = reviewMessage("Gabriela Sosa");
    expect(m).toContain("Hola Gabriela,");
    expect(m).toContain("te escribimos de VAIG");
    expect(m).not.toContain("{"); // no un-replaced placeholder
  });

  it("uses only the first name", () => {
    const m = reviewMessage("Gabriela Sosa Pérez");
    expect(m).toContain("Hola Gabriela,");
    expect(m).not.toContain("Sosa");
  });

  it("does not put the URL in the body (the template carries it as a button)", () => {
    // The body itself is button-friendly: no raw link inside the sentence.
    expect(reviewMessage("Ana")).not.toContain(GOOGLE_REVIEW_URL);
  });
});

describe("reviewWaLink", () => {
  it("builds a wa.me link with the message AND the Google URL appended", () => {
    const link = reviewWaLink("+59891234567", "Ana Pérez");
    expect(link.startsWith("https://wa.me/59891234567?text=")).toBe(true);
    const decoded = decodeURIComponent(link.split("?text=")[1]);
    expect(decoded).toContain("Hola Ana,");
    expect(decoded).toContain("te escribimos de VAIG");
    // wa.me has no buttons, so the manual path appends the link to the text.
    expect(decoded).toContain(GOOGLE_REVIEW_URL);
  });
});

describe("constants", () => {
  it("the loyalty threshold matches the documented value (mirrors the SQL)", () => {
    expect(REVIEW_MIN_SESSIONS).toBe(3);
  });

  it("points at VAIG's real Google review link", () => {
    expect(GOOGLE_REVIEW_URL).toBe("https://g.page/r/CQES5oSQeRKKEAE/review");
  });
});

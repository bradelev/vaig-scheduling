/**
 * The one place the app's palette and control sizing live (R6 consolidation).
 * Before this, two style generations were stacked: v3 screens each redeclared
 * `const ACCENT`, v2 screens used raw literals (#111 black button, #ccc border,
 * two different WhatsApp greens). This unifies them: ONE primary (blue), ONE
 * WhatsApp green, ONE control height. Inline styles stay the convention (the
 * app has no CSS system) — these are shared constants, not a framework.
 */

// Palette — the VAIG brand (2026-09-02): the panel adopts the same identity as
// the public booking page (direction "B", warm stone neutrals + teal), so the
// whole product reads as ONE thing. Contrast checked: ACCENT on white 4.9:1,
// MUTED on white 5.7:1 (the old #8a939c was 3.1:1 — small text failed AA).
export const ACCENT = "#0d7d86"; // THE primary action color (brand teal).
export const ACCENT_DARK = "#0a6870";
export const INK = "#33302b"; // warm near-black
export const MUTED = "#6b665e"; // warm gray, AA on white
export const BORDER = "#cfc8ba"; // inputs / strong lines
export const BORDER_SOFT = "#e7e2d8"; // cards / dividers
export const SURFACE = "#fff";
export const PAGE_BG = "#f7f4ee"; // the shell's warm ground behind the cards
export const WHATSAPP = "#1fa855"; // THE WhatsApp green (was #1fa855 / #1faa53).

// Feedback
export const ERROR_BG = "#fdecea";
export const ERROR_INK = "#611a15";
export const ERROR_BORDER = "#f5c6cb";
export const OK_BG = "#e7f6ec";
export const OK_INK = "#0f5b2a";
export const OK_BORDER = "#b6e3c4";

// Sizing (mobile-first: bigger than the 44px min, 16px+ fonts = no iOS zoom).
export const CONTROL_H = 48;
export const RADIUS = 10;

export const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  minHeight: CONTROL_H,
  fontSize: 16,
  padding: "0 14px",
  borderRadius: RADIUS,
  border: `1px solid ${BORDER}`,
  background: SURFACE,
  color: INK,
  boxSizing: "border-box",
  outlineOffset: 2,
};

export const PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  minHeight: CONTROL_H,
  padding: "0 18px",
  fontSize: 16,
  fontWeight: 700,
  borderRadius: RADIUS,
  border: "none",
  background: ACCENT,
  color: "#fff",
  cursor: "pointer",
};

export const LINK_BUTTON_STYLE: React.CSSProperties = {
  background: "none",
  border: "none",
  color: ACCENT,
  fontSize: 15,
  fontWeight: 600,
  padding: "10px 0",
  cursor: "pointer",
  textAlign: "left",
  minHeight: 44,
};

export const LABEL_STYLE: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: MUTED,
  textTransform: "uppercase",
  letterSpacing: "0.03em",
};

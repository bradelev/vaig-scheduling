/**
 * Normalization primitives for calendar-event matching (PRD §7.1) plus the
 * classification constants from §7.0. Shared by edge functions, UI and
 * scripts — keep this module dependency-free.
 *
 * The Spanish literals below (stopwords, patterns, nicknames) match real
 * calendar text and customer data; they are the language-rule exception
 * documented in CLAUDE.md.
 */

/**
 * Service words that never identify a client (PRD §7.1). Compared against
 * tokens AFTER normalizeText, so accented entries here are matched in their
 * unaccented form (e.g. "uñas" matches the token "unas"). Tunable list —
 * adjusted with real usage (E3-T5).
 */
export const SERVICE_STOPWORDS: readonly string[] = [
  "masaje",
  "masajes",
  "sesion",
  "laser",
  "depilacion",
  "limpieza",
  "facial",
  "corporal",
  "perfilado",
  "tinte",
  "uñas",
  "manos",
  "pies",
  "turno",
  "hora",
  "cita",
  "sra",
  "srta",
  "cliente",
];

/**
 * Employee names and nicknames (PRD §7.0). Used both to classify
 * availability events ("lu no", "steph no 3-9pm") and as stopwords, so an
 * event title like "Uñas step" never teaches "step" as a client alias
 * (§7.1). Provisional seed from the real calendar — completed/validated
 * with the team in E3-T5.
 */
export const EMPLOYEES: readonly string[] = [
  "cyn",
  "lu",
  "iara",
  "steph",
  "stephy",
  "step",
];

/**
 * Titles matching any of these are admin chores, not sessions (PRD §7.0).
 * Patterns are matched against normalizeText output (lowercase, no
 * diacritics). Seeded from real calendar data; configurable.
 */
export const NON_SESSION_PATTERNS: readonly RegExp[] = [
  /^bps\b/,
  /^pagar\b/,
  /^lista\b/,
  /^ver si\b/,
  /^mandar recordatorios/,
  /feriado/,
  /cardiolog/,
  // Bills/dues seen in the real queue (issue #48): "FACTURA GANISOL (MDEO
  // COMM) VENCE EL 10", "VENCE UTE". Anchored: client titles may contain
  // payment notes mid-string ("… ya pagó", "10% transf") and must NOT match.
  /^factura\b/,
  /^vence\b/,
  // Employee shift blocks: "Iara de 7:30 a 16:30 (9)", "Lu de 13 a 20:30",
  // and the affirmative variant "STEP SI DE 9 A 12.30-13H" (issue #84).
  // normalizeText turns "7:30" into two tokens ("7 30"), so the minutes are
  // optional after the hour: "{employee}[ si] de {h}[ {min}] a {h}". A
  // client whose name starts with an employee's is only discarded with this
  // exact schedule shape — a bare "{employee} si" without hours never is.
  new RegExp(
    `^(?:${EMPLOYEES.join("|")})(?: si)? de \\d{1,2}(?: \\d{2})? a \\d{1,2}\\b`,
  ),
];

const normalizedStopwords: ReadonlySet<string> = new Set(
  [...SERVICE_STOPWORDS, ...EMPLOYEES].map((w) => normalizeText(w)),
);

/**
 * Normalize a phone-ish string to E.164 for Uruguay (PRD §7.1).
 * Returns null for anything that doesn't unambiguously map to a Uruguayan
 * number — invalid numbers are reported, never stored (§7.1), and a false
 * positive would message the wrong person (§3), so this errs on the strict
 * side by design.
 */
export function normalizePhone(s: string): string | null {
  const digits = (s ?? "").replace(/\D/g, "");

  // Already-international 598…: validate the national part rather than
  // trusting the prefix — "any other pattern → invalid" (§7.1).
  if (digits.length === 11 && digits.startsWith("598")) {
    const national = digits.slice(3);
    return isValidNational(national) ? `+${digits}` : null;
  }
  // 09XXXXXXX — 9 digits, leading 0: mobile in local notation.
  if (digits.length === 9 && digits.startsWith("09")) {
    return `+598${digits.slice(1)}`;
  }
  // 9XXXXXXX — 8 digits starting with 9: mobile without the leading 0.
  if (digits.length === 8 && digits.startsWith("9")) {
    return `+598${digits}`;
  }
  // Landlines: 8 digits starting 2–4.
  if (digits.length === 8 && /^[2-4]/.test(digits)) {
    return `+598${digits}`;
  }
  return null;
}

function isValidNational(national: string): boolean {
  return /^9\d{7}$/.test(national) || /^[2-4]\d{7}$/.test(national);
}

/**
 * lowercase → NFD without diacritics → no punctuation → collapsed
 * whitespace (PRD §7.1). Note NFD also folds ñ → n.
 */
export function normalizeText(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * normalizeText split on whitespace, minus numeric tokens and minus the
 * service stopwords and employee names (PRD §7.1).
 */
export function tokens(s: string): string[] {
  const normalized = normalizeText(s);
  if (normalized === "") return [];
  return normalized
    .split(" ")
    .filter((t) => !/^\d+$/.test(t))
    .filter((t) => !normalizedStopwords.has(t));
}

/**
 * Generalizes a session's raw `service` into a broad, customer-friendly
 * category label for the reactivation copy (the {service} token). Two origins
 * feed `service` (see migration 20260807233345):
 *  - App sessions store a service_types SLUG ("depilacion", "limpieza_facial").
 *  - External/manual sessions carry FREE TEXT from the calendar, specific and
 *    messy ("depilacion de bozo", "limpieza de cutis con hidratacion de labios").
 *
 * Braulio's rule (2026-08-08): do NOT narrow — "depilacion de bozo" must read
 * as "Depilacion", never the zone. So we map either shape to one of the seven
 * catalog CATEGORIES by keyword. If nothing matches confidently we return null,
 * and the caller falls back to the doubtful register (no service named) rather
 * than sending a raw, ugly value.
 *
 * The catalog is the source of truth in the DB (service_types); it is mirrored
 * here as a constant because generalization is pure client-side string work and
 * the seven categories are stable. If a category is added to the seed, add it
 * here too (there is a twin-equality debt note if this drifts).
 */

/** slug -> customer-facing label, mirroring the service_types seed. */
const CATEGORY_LABEL: Record<string, string> = {
  depilacion: "Depilación",
  hifu: "HIFU",
  botox: "Botox",
  masaje: "Masaje",
  radiofrecuencia: "Radiofrecuencia",
  limpieza_facial: "Limpieza facial",
  unas: "Uñas",
};

/**
 * Keyword STEMS that identify each category in free text. Matching is by WORD
 * (the stem must start a word), not substring, so "depila" hits "depilacion"
 * but a stem never fires mid-word ("fortuna" must not read as Unas).
 *
 * The nails keyword deliberately KEEPS the n-tilde ("uña"). We strip accents
 * but preserve the n-tilde (a distinct letter, not an accented n), so "uña"
 * stays distinct from "una" — the Spanish indefinite article. Without this, a
 * calendar note like "una consulta" / "control de una cicatriz" would wrongly
 * send "tu ultima sesion de Unas". Order does not matter — categories are
 * disjoint in practice; the first hit wins.
 */
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["depilacion", ["depila"]],
  ["limpieza_facial", ["facial", "cutis", "limpieza"]],
  ["masaje", ["masaje", "maderoterapia"]],
  ["hifu", ["hifu"]],
  ["botox", ["botox", "toxina"]],
  ["radiofrecuencia", ["radiofrecuencia", "radiofrec"]],
  ["unas", ["uña", "manicur", "esmaltado"]],
];

const N_TILDE = "ñ"; // ñ
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Lowercase and strip accent marks, but PRESERVE the n-tilde. NFD splits ñ into
 * "n" + combining tilde and the mark-strip would then reduce it to a bare "n";
 * so we protect every ñ with a sentinel before NFD and restore it after. This
 * keeps "uña" distinct from "una". Same normalization spirit as lib/normalize.ts.
 */
function fold(s: string): string {
  const SENTINEL = ""; // a control char that never appears in service text
  return s
    .toLowerCase()
    .split(N_TILDE)
    .join(SENTINEL)
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .split(SENTINEL)
    .join(N_TILDE);
}

/** True when `stem` starts a word in `folded` (word start = string start or non-letter). */
function hasWordStem(folded: string, stem: string): boolean {
  // \p{L} so accented letters / n-tilde count as letters; stem must begin a word.
  return new RegExp(`(^|[^\\p{L}])${fold(stem)}`, "u").test(folded);
}

/**
 * The broad category label for a raw service value, or null when it can't be
 * generalized with confidence (empty, or no keyword/slug match).
 */
export function serviceLabel(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;

  // Exact slug from an app session — use its label directly.
  const bySlug = CATEGORY_LABEL[value.toLowerCase()];
  if (bySlug) return bySlug;

  // Free text (External/manual) — match a category by keyword stem at a word start.
  const folded = fold(value);
  for (const [slug, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((kw) => hasWordStem(folded, kw))) {
      return CATEGORY_LABEL[slug];
    }
  }
  return null;
}

/**
 * Map a booking_services free-text category (the ~20 External categories) to one
 * of the 7 service_types SLUGS that sessions.service must be (Phase 2, the
 * public reservation write). The validate_app_service trigger rejects any
 * source='app' session whose `service` isn't a service_types slug, and a
 * booking item's category is NOT a slug — so a public booking maps its item's
 * category to a slug, or stores NULL when nothing fits (a valid session, just
 * uncategorized on the agenda).
 *
 * Pure + unit-tested. The mapping is intentionally conservative: only clear
 * matches map; anything ambiguous is left null rather than mis-categorized.
 */

/** The 7 seeded service_types slugs (the only valid sessions.service values). */
export const SERVICE_SLUGS = [
  "depilacion",
  "hifu",
  "botox",
  "masaje",
  "radiofrecuencia",
  "limpieza_facial",
  "unas",
] as const;

export type ServiceSlug = (typeof SERVICE_SLUGS)[number];

/**
 * External category (free text, any case) → service_types slug, or null.
 * Matching is on normalized (lowercased, accent-insensitive) substrings so the
 * real category strings ("Depilación Láser", "Masaje Estético", "Cuponeras de
 * Depilación Láser"…) land on the right slug.
 */
export function categoryToSlug(category: string | null | undefined): ServiceSlug | null {
  if (!category) return null;
  const c = normalize(category);
  // Match WHOLE words, not substrings — "pie" as a substring would falsely hit
  // "piel" ("Revitaliza tu Piel" → wrongly unas), and "una" would hit any word
  // containing it. \b word boundaries keep each keyword to a real word.
  const has = (word: string) => new RegExp(`\\b${word}\\b`).test(c);

  // Order matters: check the more specific keywords first.
  if (has("depilacion") || has("laser")) return "depilacion";
  if (has("hifu")) return "hifu";
  if (has("botox")) return "botox";
  if (has("masaje")) return "masaje";
  if (has("radiofrecuencia")) return "radiofrecuencia";
  if (has("limpieza") || has("facial") || has("faciales")) return "limpieza_facial";
  // uñas / manos / pies — whole words only ("pie"/"pies", not "piel").
  // ("uña" itself can't appear here: NFD splits ñ into n + a tilde, and the
  // tilde is stripped — "Uñas" arrives as "unas".)
  if (has("unas") || has("manos") || has("mano") || has("pies") || has("pie"))
    return "unas";
  // Everything else (Day Spa, Nutrición, Servicios Varios, Cejas, Revitaliza tu
  // Piel…) → uncategorized (a valid session, just no category on the agenda).
  return null;
}

/** Lowercase + strip accents so "Depilación" matches "depilacion". */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // combining diacritical marks
}

/**
 * International phone normalization (2026-08-26), NODE-ONLY.
 *
 * WHY THIS EXISTS SEPARATELY from lib/normalize.ts's `normalizePhone`:
 * `lib/normalize.ts` is a dependency-free module shared with the Deno edge
 * functions (the sync-calendar bundle imports it by relative path), so it can't
 * pull in an npm package. But real clients have used non-Uruguayan numbers (USA,
 * Spain, India) and the Uruguay-only normalizer rejected them — VAIG then
 * couldn't message them at all (had to fall back to External). This module uses
 * `libphonenumber-js` (Google's phone rules, same the industry uses) to accept
 * ANY country, and lives Node-side so the Deno graph is untouched.
 *
 * The rule: if the input carries a country code (+1, +34, +91…), honor that
 * country; if it has NO country code, assume Uruguay (the local default). So a
 * bare "099123456" stays Uruguayan exactly as before, while "+1 415 555 0132"
 * is accepted as US. Validation is real (libphonenumber's `isValid()`), so we
 * never store a number WhatsApp would then reject.
 *
 * Divergence with the Deno side is intentional and safe: the sync path only
 * normalizes Uruguayan calendar-title numbers, and a foreign client degrades to
 * name/alias matching + the review queue (see the strategy doc / the Explore
 * report). Uruguayan numbers normalize identically in both, so matching is
 * unaffected for the overwhelming majority.
 */
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { normalizePhone as normalizePhoneUY } from "../normalize";

/** VAIG's local country: a number with no country code is assumed Uruguayan. */
const DEFAULT_COUNTRY = "UY" as const;

/**
 * Normalize any phone-ish string to E.164, accepting international numbers.
 * Returns the E.164 string (e.g. "+59899123456", "+14155550132") or null if
 * the number isn't a valid phone number for its (given or default) country.
 *
 * ORDER MATTERS (and guarantees exact parity with the old normalizer):
 *  1. Try the Uruguay-only `normalizePhone` FIRST. If it accepts, use its
 *     result verbatim. This makes EVERY number the old code accepted normalize
 *     byte-identically — so existing UY clients still phone-match on the Deno
 *     sync (which still uses the old normalizer), and quirks the old rules
 *     tolerate but libphonenumber rejects (e.g. UY landlines starting with 3,
 *     which aren't in Uruguay's official plan but are in our data) keep working.
 *  2. Only if the UY normalizer rejects, fall back to libphonenumber with UY as
 *     the default country: a number WITH a country code (+1/+34/+91…) is
 *     honored for that country; without one it's parsed as Uruguay. This is
 *     what adds the international numbers the old code couldn't store.
 */
export function normalizePhoneIntl(s: string): string | null {
  const raw = (s ?? "").trim();
  if (!raw) return null;

  // 1. Uruguay first — exact parity with the shared normalizer.
  const uy = normalizePhoneUY(raw);
  if (uy) return uy;

  // 2. International fallback (real validation; never store what WhatsApp rejects).
  const parsed = parsePhoneNumberFromString(raw, DEFAULT_COUNTRY);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // E.164, e.g. "+14155550132"
}

/**
 * The one place wa.me deep links are built (R4 consolidation). Before this,
 * the digit-strip + encode pattern and the copy-independent message cleanup
 * were copy-pasted across lib/reactivation/walink.ts and lib/clients/resched-link.ts.
 */

/**
 * Copy-independent message cleanup, applied after {name}/{when} interpolation:
 * strip any space left before punctuation by an empty interpolation
 * ("¡Hola ! " → "¡Hola! "), collapse doubled spaces, trim. Wording-agnostic —
 * works for whatever the final customer copy ends up being.
 */
export function cleanWaMessage(raw: string): string {
  return raw
    .replace(/\s+([!?,.;:])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * wa.me deep link. digits = the E.164 phone with every non-digit stripped
 * (wa.me wants no "+"). The message is passed through cleanWaMessage before
 * URL-encoding.
 */
export function waMeLink(phoneE164: string, message: string): string {
  const digits = phoneE164.replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(cleanWaMessage(message))}`;
}

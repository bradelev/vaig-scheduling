/**
 * Pure helpers for the Google review request feature (2026-08-10). No I/O —
 * eligibility is enforced in the v_review_candidates SQL; this holds the shared
 * constants and the customer-facing copy so both the staff screen and (later)
 * the automated WhatsApp template agree on one wording.
 */
import { firstName } from "../reactivation/walink";
import { waMeLink } from "../whatsapp/walink";

/** VAIG's Google review deep link (Braulio, 2026-08-10). */
export const GOOGLE_REVIEW_URL = "https://g.page/r/CQES5oSQeRKKEAE/review";

/** Loyalty threshold: completed sessions that make a client eligible. Mirrors
 *  the `>= 3` in v_review_candidates — keep the two in sync. */
export const REVIEW_MIN_SESSIONS = 3;

/** Days before the same client can be asked again. Mirrors the SQL grace. */
export const REVIEW_GRACE_DAYS = 90;

/**
 * Customer-facing copy (Spanish by design). {name} → first name.
 *
 * This is the EXACT body of the approved WhatsApp template `pedido_resena`
 * (MARKETING, es_UY, approved 2026-08-11) minus the {{1}} → {name} placeholder.
 * The manual wa.me path (staff screen) sends the same wording; keep these two in
 * sync so a client sees identical copy whether the bot or a staffer sends it.
 * The Google link rides in a URL button in the template; wa.me has no buttons,
 * so the manual path appends it to the text — see reviewWaLink.
 */
export const REVIEW_REQUEST_MESSAGE =
  "Hola {name}, te escribimos de VAIG por la sesión de ayer. Si quedaste conforme, dejanos tu opinión en Google. Nos ayuda un montón a que la gente nos encuentre.";

/** Fills the review-request copy for one client. */
export function reviewMessage(fullName: string): string {
  return REVIEW_REQUEST_MESSAGE.replace("{name}", firstName(fullName));
}

/**
 * wa.me deep link with the prefilled review request — the manual send path
 * (staff screen) while the automated template is pending Meta approval. wa.me
 * has no buttons, so the Google link is appended to the message text (the
 * template carries it as a URL button instead).
 */
export function reviewWaLink(phoneE164: string, fullName: string): string {
  return waMeLink(phoneE164, `${reviewMessage(fullName)} ${GOOGLE_REVIEW_URL}`);
}

/**
 * Pure helpers for the Reactivation view (PRD FR-4, issue E3-T4). No I/O — the
 * page builds the wa.me links from view rows. Kept testable so the message
 * interpolation and digit stripping are verified without a stack.
 */
import { monthLabel } from "./month";
import { serviceLabel } from "./service-label";
import { waMeLink } from "../whatsapp/walink";

/**
 * Reactivation copy (Braulio + team, 2026-08-08). Three registers, one per data
 * situation. All customer-facing (Spanish by design), signed by a real person,
 * with a binary CTA ("te agendo o te escribo más adelante?") that is hard to
 * ignore without reading as a sales pitch.
 *
 * {name}      → client's first name
 * {signature} → the receptionist writing (configurable; "Lu" today, "Valentina"
 *               when she starts — set on the Reactivación screen)
 * {service}   → the client's last service (from the row)
 * {month}     → the month of that last session, in Montevideo local time
 *
 * VERIFIED registers (both {service} and {month} known) come in two flavors that
 * differ only by the "Entré hace poco y " lead — toggled by the "soy nueva"
 * checkbox. DOUBTFUL (service or date missing) drops both tokens so we never
 * send "tu sesión de  fue en " with empty holes.
 */
export const REACTIVATION_NEW_MESSAGE =
  "Hola {name}, soy {signature} de VAIG. Entré hace poco y estoy revisando la agenda: vi que tu última sesión de {service} fue en {month} y no tenés ninguna reservada. Te agendo un turno estos días o preferís que te escriba más adelante?";

export const REACTIVATION_VERIFIED_MESSAGE =
  "Hola {name}, soy {signature} de VAIG. Estoy revisando la agenda y vi que tu última sesión de {service} fue en {month} y no tenés ninguna reservada. Te agendo un turno estos días o preferís que te escriba más adelante?";

export const REACTIVATION_DOUBTFUL_NEW_MESSAGE =
  "Hola {name}, soy {signature} de VAIG. Entré hace poco y estoy revisando la agenda. Vi que no tenés ninguna sesión reservada. Te agendo un turno estos días o preferís que te escriba más adelante?";

export const REACTIVATION_DOUBTFUL_MESSAGE =
  "Hola {name}, soy {signature} de VAIG. Estoy revisando la agenda y vi que no tenés ninguna sesión reservada. Te agendo un turno estos días o preferís que te escriba más adelante?";

/** Default signature until the receptionist changes it on the screen. */
export const DEFAULT_SIGNATURE = "Lu";

/** Options that select and fill the reactivation register for one client. */
export type ReactivationOpts = {
  /** Receptionist's name (the {signature} token). Falls back to DEFAULT_SIGNATURE. */
  signature?: string;
  /** "Entré hace poco y " lead — the receptionist's "soy nueva" checkbox. */
  isNew?: boolean;
  /** The client's last service ({service}); null/"" → doubtful register. */
  service?: string | null;
  /** ISO of the last session ({month} source); null → doubtful register. */
  lastSessionIso?: string | null;
  /** Injectable clock for month formatting (tests). */
  now?: Date;
};

/**
 * Picks the register (new/verified/doubtful) from the data available and fills
 * its tokens. The register is DOUBTFUL when either the service or the last
 * session date is missing — that's the "when in doubt, drop the specifics" rule.
 */
export function reactivationMessage(
  fullName: string,
  opts: ReactivationOpts = {},
): string {
  const signature = (opts.signature ?? "").trim() || DEFAULT_SIGNATURE;
  // Generalize the raw service ("depilación de bozo" → "Depilación"); null when
  // it can't be mapped to a catalog category. Specifics also need a real date.
  const service = serviceLabel(opts.service);
  const hasSpecifics = service !== null && !!opts.lastSessionIso;

  let template: string;
  if (hasSpecifics) {
    template = opts.isNew
      ? REACTIVATION_NEW_MESSAGE
      : REACTIVATION_VERIFIED_MESSAGE;
  } else {
    template = opts.isNew
      ? REACTIVATION_DOUBTFUL_NEW_MESSAGE
      : REACTIVATION_DOUBTFUL_MESSAGE;
  }

  let message = template
    .replace("{name}", firstName(fullName))
    .replace("{signature}", signature);
  if (hasSpecifics) {
    message = message
      .replace("{service}", service as string)
      .replace("{month}", monthLabel(opts.lastSessionIso as string, opts.now));
  }
  return message;
}

/**
 * Copy for the retention follow-up (issue #107): a client attended recently
 * and left without a next date. Warmer/earlier than reactivation — she was
 * just here. Sent from the shop's human number (wa.me), the receptionist
 * edits before sending. {name} interpolated; provisional wording.
 */
export const REBOOK_FOLLOWUP_MESSAGE =
  "¡Hola {name}! 🌸 ¿Coordinamos tu próxima sesión así te guardamos el lugar?";

/** wa.me deep link for the rebook follow-up (issue #107). */
export function rebookWaLink(phoneE164: string, fullName: string): string {
  const message = REBOOK_FOLLOWUP_MESSAGE.replace("{name}", firstName(fullName));
  return waMeLink(phoneE164, message);
}

/** First whitespace-separated token of the trimmed name; "" for empty. */
export function firstName(fullName: string): string {
  const trimmed = fullName.trim();
  if (trimmed === "") return "";
  return trimmed.split(/\s+/)[0];
}

/**
 * wa.me deep link with the prefilled reactivation message. The message is
 * picked and filled by reactivationMessage from the data in `opts` (signature,
 * isNew, service, lastSessionIso); waMeLink (R4) then does the digit-strip,
 * copy-independent cleanup and URL-encoding.
 */
export function waLink(
  phoneE164: string,
  fullName: string,
  opts: ReactivationOpts = {},
): string {
  return waMeLink(phoneE164, reactivationMessage(fullName, opts));
}

/**
 * wa.me quick action for the "Pidió reagendar 🔁" rows (issue #62). The link
 * opens the OPERATOR's own WhatsApp — the shop's human number — with the
 * message prefilled: the bot number never converses (two-number model,
 * Braulio 2026-07-21). Pure and I/O-free, same testability contract as
 * lib/reactivation/walink.ts.
 */
import { firstName } from "../reactivation/walink";
import { waMeLink } from "../whatsapp/walink";

/** Customer-facing copy (Spanish by design). {name}/{when} interpolated. */
export const RESCHED_MESSAGE =
  "¡Hola {name}! Vimos que pediste reagendar tu sesión del {when}. ¿Qué horario te queda bien?";

/**
 * "22/07 a las 15:00" in Montevideo. en-CA parts + manual padding — es-UY
 * drops leading zeros in some ICU builds (same workaround as formatWhen).
 */
export function reschedWhenLabel(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) =>
    (parts.find((p) => p.type === t)?.value ?? "").padStart(2, "0");
  return `${get("day")}/${get("month")} a las ${get("hour")}:${get("minute")}`;
}

export function reschedWaLink(
  phoneE164: string,
  fullName: string,
  startsAtIso: string,
): string {
  const message = RESCHED_MESSAGE.replace("{name}", firstName(fullName)).replace(
    "{when}",
    reschedWhenLabel(startsAtIso),
  );
  return waMeLink(phoneE164, message);
}

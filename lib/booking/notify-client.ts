/**
 * Tell the client their reservation was confirmed by the team, via the
 * `reserva_confirmada` WhatsApp template (Phase 2, the internal booking plan
 * §"Templates de Meta necesarios"). Best-effort: the confirm action wraps the
 * call so a failure here never un-confirms the reservation. Node-only.
 *
 * Template `reserva_confirmada` (es_UY, Utility, 4 body params):
 *   {{1}} client name, {{2}} service name, {{3}} date+time (Montevideo,
 *   Spanish), {{4}} preparation instruction (chosen by service category).
 * The business data (PIN, address, phone) lives ONLY in the template body in
 * Meta — never in the repo.
 */
import { categoryToSlug } from "./service-category";
import { dateTimeLabel, sendTemplate } from "./wa-template";

export const CLIENT_CONFIRMED_TEMPLATE = "reserva_confirmada";

/**
 * The preparation instruction for {{4}}, by the booked item's category.
 * Customer-facing copy (Spanish). Never empty — Meta rejects an empty param.
 */
export function prepInstructionFor(category: string | null): string {
  const slug = categoryToSlug(category);
  if (slug === "depilacion") return "Vení con la zona rasurada del día anterior.";
  const c = (category ?? "").toLowerCase();
  if (slug === "limpieza_facial" || c.includes("ceja") || c.includes("pesta")) {
    return "Vení sin maquillaje.";
  }
  return "No necesitás ninguna preparación especial.";
}

export async function notifyReservationConfirmed(input: {
  /** E.164 with '+'. */
  clientPhone: string;
  clientName: string | null;
  serviceName: string;
  category: string | null;
  startsAt: string;
}): Promise<void> {
  await sendTemplate({
    to: input.clientPhone,
    template: CLIENT_CONFIRMED_TEMPLATE,
    params: [
      // Neutral when there's no usable name: the body may open with "Hola
      // {{1}}", so a greeting here would double up. Revisit against the
      // approved body once it's visible in Business Manager.
      input.clientName?.trim() || "clienta",
      input.serviceName,
      dateTimeLabel(input.startsAt),
      prepInstructionFor(input.category),
    ],
    stubLabel: "reservation-confirmed notice to client",
  });
}

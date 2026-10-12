/**
 * Notify the assigned professional of a new "por confirmar" reservation via the
 * `nueva_reserva_staff` WhatsApp template (Phase 2). Best-effort: reserve.ts
 * wraps the call so a failure here never fails the booking. Node-only.
 *
 * Template `nueva_reserva_staff` (es_UY, Utility, 3 body params):
 *   📅 Tenés una nueva reserva para confirmar.
 *   La clienta {{1}} reservó {{2}} para el {{3}}.
 *   Entrá al panel de VAIG para confirmarla o reagendarla.
 * → {{1}} client name, {{2}} service name, {{3}} date+time (Montevideo, Spanish).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { dateTimeLabel, sendTemplate } from "./wa-template";

const STAFF_TEMPLATE = "nueva_reserva_staff";

/**
 * Look up the assigned staff's phone and send them the new-reservation notice.
 * Silently returns if the staff has no phone on file (NULL until loaded in prod)
 * — a reservation without a staff notice is fine; the "por confirmar" panel is
 * the backstop. Throws only on a real Meta send error (reserve.ts swallows it).
 */
export async function notifyNewReservation(
  db: SupabaseClient,
  input: { staffId: string; clientName: string | null; serviceName: string; startsAt: string },
): Promise<void> {
  const res = await db.from("staff").select("phone").eq("id", input.staffId).maybeSingle();
  if (res.error) throw new Error(`notifyNewReservation staff lookup: ${res.error.message}`);
  const phone = (res.data?.phone as string | null | undefined) ?? null;
  if (!phone) return; // no phone on file → nothing to send

  await sendTemplate({
    to: phone,
    template: STAFF_TEMPLATE,
    params: [
      input.clientName?.trim() || "una clienta",
      input.serviceName,
      dateTimeLabel(input.startsAt),
    ],
    stubLabel: "new-reservation notice to staff",
  });
}

/** Kept under its historical name for existing callers/tests. */
export const staffDateTimeLabel = dateTimeLabel;

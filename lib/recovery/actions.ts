"use server";

/**
 * Staff actions on the "reservas a medio camino" queue
 * (docs/booking-analytics.md). Human, one-by-one outreach — there is
 * deliberately NO automated send here: the wa.me link opens the local's own
 * WhatsApp and a person decides. requireStaff on every action (the
 * packages/actions.ts convention).
 */
import { revalidatePath } from "next/cache";
import { requireStaff } from "../auth/require-staff";
import { serviceClient } from "../supabase/service";

type Result = { ok: true } | { error: string };

/** Mark one queue row as contacted (or clear the mark to redo it). */
export async function markRecoveryContacted(input: {
  phone: unknown;
  contacted: boolean;
}): Promise<Result> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const phone = input.phone;
  if (typeof phone !== "string" || !/^\+\d{6,15}$/.test(phone)) {
    return { error: "Teléfono inválido." };
  }
  const { data, error } = await serviceClient()
    .from("booking_recovery")
    .update({ contacted_at: input.contacted ? new Date().toISOString() : null })
    .eq("phone", phone)
    .select("phone")
    .maybeSingle();
  if (error) return { error: `No se pudo actualizar: ${error.message}` };
  if (!data) return { error: "Esa fila ya no está (venció o completó su reserva)." };
  revalidatePath("/metricas");
  return { ok: true };
}

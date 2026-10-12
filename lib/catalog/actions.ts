"use server";

/**
 * Staff actions on the service catalog (booking_services) — the Servicios
 * panel. Every action re-checks the staff session (requireStaff) and runs as
 * the service role. Services are never hard-deleted (sessions and
 * client_packages reference them) — only deactivated.
 */
import { revalidatePath } from "next/cache";
import { looksLikeUuid } from "../booking/reserve";
import { validateServiceDraft } from "./validate";
import { requireStaff } from "../auth/require-staff";
import { serviceClient } from "../supabase/service";

type Result = { ok: true } | { error: string };

export async function createService(
  input: unknown,
): Promise<{ ok: true; id: string } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const validated = validateServiceDraft(input);
  if ("error" in validated) return { error: validated.error };
  const { draft } = validated;
  const db = serviceClient();
  const { data, error } = await db
    .from("booking_services")
    .insert({
      name: draft.name,
      category: draft.category,
      duration_min: draft.durationMin,
      price_uyu: draft.priceUyu,
      package_sessions: draft.packageSessions,
    })
    .select("id")
    .single();
  if (error) return { error: `No se pudo crear el servicio: ${error.message}` };
  revalidatePath("/servicios");
  return { ok: true, id: data.id as string };
}

export async function updateService(input: { id: unknown; draft: unknown }): Promise<Result> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const id = input.id;
  if (typeof id !== "string" || !looksLikeUuid(id)) return { error: "Identificador inválido." };
  const validated = validateServiceDraft(input.draft);
  if ("error" in validated) return { error: validated.error };
  const { draft } = validated;
  const db = serviceClient();
  const { data, error } = await db
    .from("booking_services")
    .update({
      name: draft.name,
      category: draft.category,
      duration_min: draft.durationMin,
      price_uyu: draft.priceUyu,
      package_sessions: draft.packageSessions,
    })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return { error: `No se pudo actualizar el servicio: ${error.message}` };
  if (!data) return { error: "No se encontró el servicio." };
  revalidatePath("/servicios");
  return { ok: true };
}

export async function setServiceActive(input: { id: unknown; active: boolean }): Promise<Result> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const id = input.id;
  if (typeof id !== "string" || !looksLikeUuid(id)) return { error: "Identificador inválido." };
  const db = serviceClient();
  const { data, error } = await db
    .from("booking_services")
    .update({ active: input.active })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return { error: `No se pudo actualizar el servicio: ${error.message}` };
  if (!data) return { error: "No se encontró el servicio." };
  revalidatePath("/servicios");
  return { ok: true };
}

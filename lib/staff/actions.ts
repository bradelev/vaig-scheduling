"use server";

/**
 * Staff actions on the professionals catalog (staff, staff_services) — the
 * Profesionales panel. Every action re-checks the staff session
 * (requireStaff) and runs as the service role. Staff are never hard-deleted
 * (sessions and client_packages reference them) — only deactivated.
 */
import { revalidatePath } from "next/cache";
import { looksLikeUuid } from "../booking/reserve";
import { staffSlug, validatePriority, validateStaffDraft } from "./validate";
import { requireStaff } from "../auth/require-staff";
import { serviceClient } from "../supabase/service";

type Result = { ok: true } | { error: string };

export async function createStaffMember(
  input: unknown,
): Promise<{ ok: true; id: string } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const validated = validateStaffDraft(input);
  if ("error" in validated) return { error: validated.error };
  const { draft } = validated;
  // Cap at 40 to stay editable: every other action rejects ids over 40 chars,
  // so a longer slug would create a professional nobody can ever edit.
  const slug = staffSlug(draft.name).slice(0, 40);
  if (slug === "") return { error: "El nombre necesita al menos una letra." };
  const db = serviceClient();
  const { data: existing, error: lookupError } = await db
    .from("staff")
    .select("id")
    .eq("id", slug)
    .maybeSingle();
  if (lookupError) return { error: `No se pudo verificar el código: ${lookupError.message}` };
  if (existing) return { error: `Ya existe una profesional con ese código (${slug}).` };
  const { error } = await db
    .from("staff")
    .insert({ id: slug, name: draft.name, phone: draft.phone, color_id: draft.colorId });
  if (error) return { error: `No se pudo crear la profesional: ${error.message}` };
  revalidatePath("/profesionales");
  return { ok: true, id: slug };
}

export async function updateStaffMember(input: { id: unknown; draft: unknown }): Promise<Result> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const id = input.id;
  if (typeof id !== "string" || id.length < 1 || id.length > 40) {
    return { error: "Identificador inválido." };
  }
  const validated = validateStaffDraft(input.draft);
  if ("error" in validated) return { error: validated.error };
  const { draft } = validated;
  const db = serviceClient();
  const { data, error } = await db
    .from("staff")
    .update({ name: draft.name, phone: draft.phone, color_id: draft.colorId })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return { error: `No se pudo actualizar la profesional: ${error.message}` };
  if (!data) return { error: "No se encontró la profesional." };
  revalidatePath("/profesionales");
  return { ok: true };
}

export async function setStaffActive(input: { id: unknown; active: boolean }): Promise<Result> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const id = input.id;
  if (typeof id !== "string" || id.length < 1 || id.length > 40) {
    return { error: "Identificador inválido." };
  }
  const db = serviceClient();
  const { data, error } = await db
    .from("staff")
    .update({ active: input.active })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return { error: `No se pudo actualizar la profesional: ${error.message}` };
  if (!data) return { error: "No se encontró la profesional." };
  revalidatePath("/profesionales");
  return { ok: true };
}

export async function setStaffPriority(input: { id: unknown; priority: unknown }): Promise<Result> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const id = input.id;
  if (typeof id !== "string" || id.length < 1 || id.length > 40) {
    return { error: "Identificador inválido." };
  }
  const validated = validatePriority(input.priority);
  if ("error" in validated) return { error: validated.error };
  const db = serviceClient();
  // .select() so the update reports what it matched: with zero links the
  // priority would persist NOWHERE, and silently confirming it would lose it.
  const { data, error } = await db
    .from("staff_services")
    .update({ priority: validated.priority })
    .eq("staff_id", id)
    .select("booking_service_id");
  if (error) return { error: `No se pudo actualizar la prioridad: ${error.message}` };
  if (!data || data.length === 0) {
    return { error: "Todavía no tiene servicios marcados — primero marcá qué servicios da y después fijá la prioridad." };
  }
  revalidatePath("/profesionales");
  return { ok: true };
}

/** The mode (most common value) of a list of numbers; null for an empty list. */
function mode(values: number[]): number | null {
  if (values.length === 0) return null;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [value, count] of Array.from(counts.entries())) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export async function setStaffServices(input: { id: unknown; serviceIds: unknown }): Promise<Result> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const id = input.id;
  if (typeof id !== "string" || id.length < 1 || id.length > 40) {
    return { error: "Identificador inválido." };
  }
  const serviceIds = input.serviceIds;
  if (!Array.isArray(serviceIds) || serviceIds.length > 200) {
    return { error: "Lista de servicios inválida." };
  }
  for (const s of serviceIds) {
    if (typeof s !== "string" || !looksLikeUuid(s)) return { error: "Lista de servicios inválida." };
  }
  const wanted = new Set(serviceIds as string[]);

  const db = serviceClient();
  const { data: currentRows, error: readError } = await db
    .from("staff_services")
    .select("booking_service_id, priority")
    .eq("staff_id", id);
  if (readError) return { error: `No se pudieron leer los servicios actuales: ${readError.message}` };
  const rows = (currentRows ?? []) as { booking_service_id: string; priority: number }[];
  const current = new Set(rows.map((r) => r.booking_service_id));

  const toAdd = Array.from(wanted).filter((s) => !current.has(s));
  const toRemove = Array.from(current).filter((s) => !wanted.has(s));

  const newPriority = mode(rows.map((r) => r.priority)) ?? 100;

  if (toAdd.length > 0) {
    const { error } = await db
      .from("staff_services")
      .insert(toAdd.map((serviceId) => ({ staff_id: id, booking_service_id: serviceId, priority: newPriority })));
    if (error) return { error: `No se pudieron agregar los servicios: ${error.message}` };
  }
  if (toRemove.length > 0) {
    const { error } = await db
      .from("staff_services")
      .delete()
      .eq("staff_id", id)
      .in("booking_service_id", toRemove);
    if (error) return { error: `No se pudieron quitar los servicios: ${error.message}` };
  }

  revalidatePath("/profesionales");
  return { ok: true };
}

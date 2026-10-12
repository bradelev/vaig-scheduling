"use server";

/**
 * Server Actions for inline edits to the client book from the Clientes grid
 * (issue #128). Mutates `clients`: full_name, phone, is_first_visit. Runs
 * server-side with the service role (the browser never sees the key). Phone is
 * normalized and kept unique — editing to a number that already belongs to a
 * different client is refused, never silently reassigned.
 */
import { revalidatePath } from "next/cache";
import { normalizePhoneIntl } from "./phone";
import { serviceClient } from "../supabase/service";
import { requireStaff } from "../auth/require-staff";
import { assertPhoneFree, findOrCreateClient } from "./upsert";

/**
 * Edit one client's editable fields. Only the provided fields change. Returns
 * the normalized phone on success (the grid re-renders it) or a Spanish error.
 */
export async function updateClient(input: {
  clientId: string;
  fullName?: string;
  phone?: string;
  isFirstVisit?: boolean;
}): Promise<{ ok: true; phone?: string } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const db = serviceClient();
  const patch: Record<string, unknown> = {};

  if (input.fullName !== undefined) {
    const name = input.fullName.trim();
    if (!name) return { error: "El nombre no puede quedar vacío." };
    patch.full_name = name;
  }

  let normalizedPhone: string | undefined;
  if (input.phone !== undefined) {
    const phone = normalizePhoneIntl(input.phone);
    if (!phone) return { error: "El teléfono no es válido." };
    // Unique: refuse a number owned by ANOTHER client (never a silent merge).
    const conflict = await assertPhoneFree(db, phone, input.clientId);
    if (conflict) return { error: conflict };
    patch.phone = phone;
    normalizedPhone = phone;
  }

  if (input.isFirstVisit !== undefined) {
    patch.is_first_visit = input.isFirstVisit;
  }

  if (Object.keys(patch).length === 0) return { ok: true };

  const { data: updated, error } = await db
    .from("clients")
    .update(patch)
    .eq("id", input.clientId)
    .select("id");
  if (error) return { error: `No se pudo guardar: ${error.message}` };
  if (!updated || updated.length === 0) {
    return { error: "No se encontró la clienta." };
  }

  revalidatePath("/clientes");
  return { ok: true, phone: normalizedPhone };
}

/**
 * Add a client to the book, independent of any session (curating the ~1,300-row
 * identity DB — PRD §2/§4: `clients` is the source of truth for identity).
 * Reuses findOrCreateClient so the phone-uniqueness / same-name-reuse /
 * conflict rules are the SAME as every other create path. Returns the id on
 * success or a Spanish error.
 */
export async function createClient(input: {
  fullName: string;
  phone: string;
}): Promise<
  { ok: true; clientId: string; reused: boolean } | { error: string }
> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const db = serviceClient();
  const res = await findOrCreateClient(db, {
    fullName: input.fullName,
    phone: input.phone,
  });
  if ("error" in res) return res;
  // `reused` = the name+phone already existed; the caller must NOT render it as
  // a brand-new row (that phantom row would hide the client's real history).
  if (!res.reused) revalidatePath("/clientes");
  return { ok: true, clientId: res.clientId, reused: res.reused };
}

/**
 * Delete a client — ONLY when she has no sessions at all (data curation: test
 * rows, duplicates, junk). This is the guard against the destructive path:
 * `sessions.client_id references clients(id) ON DELETE CASCADE`, so deleting a
 * client with history would silently take her sessions with her.
 *
 * The safety check counts the `sessions` table DIRECTLY (not v_client_status,
 * which hides cancelled sessions) — a client with only a cancelled session
 * still owns a cascade-deletable row, so she is NOT deletable here. Her
 * `aliases` are the only thing that cascades, which is correct (an orphan alias
 * is useless).
 */
export async function deleteClient(input: {
  clientId: string;
}): Promise<{ ok: true } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const db = serviceClient();

  // Authoritative count over sessions (all statuses, incl. cancelled).
  const { count, error: countErr } = await db
    .from("sessions")
    .select("id", { count: "exact", head: true })
    .eq("client_id", input.clientId);
  if (countErr) {
    return { error: `No se pudo verificar: ${countErr.message}` };
  }
  if ((count ?? 0) > 0) {
    return {
      error:
        `Tiene ${count} ${count === 1 ? "sesión" : "sesiones"} en el ` +
        `historial; no se puede eliminar. Solo se pueden borrar clientas ` +
        `sin ninguna sesión.`,
    };
  }

  const { data: deleted, error } = await db
    .from("clients")
    .delete()
    .eq("id", input.clientId)
    .select("id");
  if (error) return { error: `No se pudo eliminar: ${error.message}` };
  if (!deleted || deleted.length === 0) {
    return { error: "No se encontró la clienta." };
  }

  revalidatePath("/clientes");
  return { ok: true };
}

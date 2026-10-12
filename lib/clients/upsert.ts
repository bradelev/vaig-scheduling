/**
 * The ONE place a client is found-or-created and the "phone is unique" rule is
 * enforced (issue: product consolidation, F1). Before this, three server
 * actions each reimplemented the conflict/reuse/create decision by hand
 * (createSession's inline new client, createClientAndResolve, updateClient) —
 * with a real observable drift (is_first_visit set on one path, not the other)
 * and the conflict error string duplicated. They now all go through here.
 *
 * Not a Server Action itself (no "use server") — a plain module the actions
 * import, so it can be reused without the RPC boundary.
 */
import { normalizePhoneIntl } from "./phone";
import type { serviceClient } from "../supabase/service";

type Db = ReturnType<typeof serviceClient>;

/** Pure: what to do when creating a client whose phone may already exist. */
export function newClientDecision(
  existing: { full_name: string } | null,
  name: string,
): "reuse" | "conflict" | "create" {
  if (!existing) return "create";
  return existing.full_name.trim().toLowerCase() === name.trim().toLowerCase()
    ? "reuse"
    : "conflict";
}

/** The single conflict message (was duplicated across two actions). */
export function phoneConflictMessage(ownerName: string): string {
  return (
    `Ese teléfono ya es de "${ownerName}". Si es la misma persona, ` +
    `asignala desde la lista; si no, revisá el número.`
  );
}

/**
 * Find a client by phone or create one. Enforces phone uniqueness: a phone that
 * already belongs to someone with a DIFFERENT name is a conflict (never a
 * silent rename); the same name+phone reuses the existing row (idempotent).
 * `isFirstVisit` is applied only when a client is actually created.
 */
export async function findOrCreateClient(
  db: Db,
  input: { fullName: string; phone: string; isFirstVisit?: boolean },
): Promise<{ clientId: string; reused: boolean } | { error: string }> {
  const name = input.fullName.trim();
  if (!name) return { error: "Falta el nombre." };
  const phone = normalizePhoneIntl(input.phone);
  if (!phone) return { error: "El teléfono no es válido." };

  const { data: existing, error: findErr } = await db
    .from("clients")
    .select("id, full_name")
    .eq("phone", phone)
    .maybeSingle();
  if (findErr) {
    return { error: `No se pudo verificar el teléfono: ${findErr.message}` };
  }

  const decision = newClientDecision(existing, name);
  if (decision === "conflict") {
    return { error: phoneConflictMessage(existing!.full_name) };
  }
  if (decision === "reuse") {
    // Same name+phone already in the book — hand back the existing row so
    // callers don't create a duplicate. `reused` lets a UI say "ya existe"
    // instead of optimistically rendering a phantom second row.
    return { clientId: existing!.id, reused: true };
  }
  const { data: created, error: cErr } = await db
    .from("clients")
    .insert({ full_name: name, phone, is_first_visit: input.isFirstVisit ?? false })
    .select("id")
    .single();
  if (cErr) return { error: `No se pudo crear la clienta: ${cErr.message}` };
  return { clientId: created!.id, reused: false };
}

/**
 * Assert a phone isn't already owned by ANOTHER client (for the EDIT path, where
 * the client keeps their own phone). Returns an error string or null.
 */
export async function assertPhoneFree(
  db: Db,
  phone: string,
  exceptClientId: string,
): Promise<string | null> {
  const { data: owner, error } = await db
    .from("clients")
    .select("id, full_name")
    .eq("phone", phone)
    .maybeSingle();
  if (error) return `No se pudo verificar el teléfono: ${error.message}`;
  if (owner && owner.id !== exceptClientId) {
    return `Ese teléfono ya es de "${owner.full_name}".`;
  }
  return null;
}

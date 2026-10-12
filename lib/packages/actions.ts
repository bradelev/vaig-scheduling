"use server";

/**
 * Staff actions on cuponeras (prepaid packages) — the Cuponeras panel.
 * Every action re-checks the staff session (requireStaff) and runs as the
 * service role. The ledger (used_sessions) only moves through
 * adjust_package_credit, clamped in the DB.
 */
import { revalidatePath } from "next/cache";
import { requireStaff } from "../auth/require-staff";
import { serviceClient } from "../supabase/service";

type Result = { ok: true } | { error: string };

/** Day 1: the client paid at the desk (POS / transfer). */
export async function markPackagePaid(input: { packageId: string }): Promise<Result> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const db = serviceClient();
  const { data, error } = await db
    .from("client_packages")
    .update({ status: "pagada", paid_at: new Date().toISOString() })
    .eq("id", input.packageId)
    .eq("status", "pendiente_pago")
    .select("id");
  if (error) return { error: `No se pudo marcar la cuponera: ${error.message}` };
  if (!data || data.length === 0) return { error: "No se encontró la cuponera." };
  revalidatePath("/");
  return { ok: true };
}

/** +1 = a session taken by hand (no-show); -1 = a credit returned. */
export async function adjustPackageCredit(input: {
  packageId: string;
  delta: 1 | -1;
}): Promise<Result> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  if (input.delta !== 1 && input.delta !== -1) return { error: "Ajuste inválido." };
  const db = serviceClient();
  const { data, error } = await db.rpc("adjust_package_credit", {
    p_package: input.packageId,
    p_delta: input.delta,
  });
  if (error) return { error: `No se pudo ajustar el saldo: ${error.message}` };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { error: "No se encontró la cuponera." };
  revalidatePath("/");
  return { ok: true };
}

/** Void a package (mistake / refund). Its sessions keep their link for history. */
export async function cancelPackage(input: { packageId: string }): Promise<Result> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const db = serviceClient();
  const { data, error } = await db
    .from("client_packages")
    .update({ status: "cancelada" })
    .eq("id", input.packageId)
    .neq("status", "cancelada")
    .select("id");
  if (error) return { error: `No se pudo cancelar la cuponera: ${error.message}` };
  if (!data || data.length === 0) return { error: "No se encontró la cuponera." };
  revalidatePath("/");
  return { ok: true };
}

/**
 * Load a package by hand — the ones sold before VAIG, or sold at the desk.
 * `usedSessions` lets the team enter a treatment already under way.
 */
export async function createPackageManually(input: {
  clientId: string;
  serviceId: string;
  totalSessions: number;
  usedSessions?: number;
  paid: boolean;
}): Promise<{ ok: true; packageId: string } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const total = Math.floor(Number(input.totalSessions));
  const used = Math.floor(Number(input.usedSessions ?? 0));
  if (!input.clientId || !input.serviceId) return { error: "Falta la clienta o el ítem." };
  if (!Number.isFinite(total) || total < 1 || total > 60) return { error: "La cantidad de sesiones no es válida." };
  if (!Number.isFinite(used) || used < 0 || used > total) return { error: "Las sesiones usadas no son válidas." };
  const db = serviceClient();
  const { data, error } = await db
    .from("client_packages")
    .insert({
      client_id: input.clientId,
      booking_service_id: input.serviceId,
      total_sessions: total,
      used_sessions: used,
      status: input.paid ? "pagada" : "pendiente_pago",
      paid_at: input.paid ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  if (error) return { error: `No se pudo crear la cuponera: ${error.message}` };
  revalidatePath("/");
  return { ok: true, packageId: data.id as string };
}

/** Client picker for the manual form: partial name/phone, a few matches. */
export async function searchClients(input: {
  q: string;
}): Promise<{ clients: { id: string; fullName: string; phone: string }[] } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const q = input.q.trim();
  if (q.length < 2) return { clients: [] };
  const db = serviceClient();
  // PostgREST `or` filter; escape the wildcard/comma characters a user could type.
  const safe = q.replace(/[%,()]/g, " ").replace(/\s+/g, " ").trim();
  const { data, error } = await db
    .from("clients")
    .select("id, full_name, phone")
    // Phones are stored E.164 (+598…): a typed "099…" must match "+59899…".
    .or(`full_name.ilike.%${safe}%,phone.ilike.%${safe.replace(/\D/g, "").replace(/^0/, "") || safe}%`)
    .order("full_name")
    .limit(8);
  if (error) return { error: error.message };
  return {
    clients: (data ?? []).map((c) => ({
      id: c.id as string,
      fullName: c.full_name as string,
      phone: c.phone as string,
    })),
  };
}

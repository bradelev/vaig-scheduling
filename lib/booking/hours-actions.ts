"use server";

/**
 * Server Actions for the hours editor (Phase 1C.2). CRUD over staff_hours for a
 * given staff member: list their rules, add a rule, delete a rule. Reception
 * edits everyone's hours under the current login (no per-employee auth yet).
 *
 * Runs as the service role like the other session actions. The staff id is
 * validated against the staff table (never trust the client), and every rule is
 * validated by the pure validateRule() (mirrors the DB CHECK constraints) so a
 * bad shape is a clear Spanish message, not an opaque constraint error.
 */
import { revalidatePath } from "next/cache";
import { serviceClient } from "../supabase/service";
import { requireStaff } from "../auth/require-staff";
import { isKnownStaff } from "../sessions/staff";
import { validateRule, type RuleDraft } from "./hours-rules";

/** One staff_hours row as the editor lists it. */
export type HourRuleRow = {
  id: string;
  kind: "weekly" | "open" | "block";
  weekday: number | null;
  on_date: string | null;
  start_min: number | null;
  end_min: number | null;
};

/** All rules for a staff member, ordered for a stable editor render. */
export async function listStaffHours(
  staffId: string,
): Promise<{ rules: HourRuleRow[] } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  if (!staffId) return { error: "Falta la profesional." };
  const db = serviceClient();
  // Gate on a real staff id for parity with add/delete (the picker only offers
  // active staff, but never trust the client).
  if (!(await isKnownStaff(db, staffId))) {
    return { error: "Esa profesional no existe o está inactiva." };
  }
  const { data, error } = await db
    .from("staff_hours")
    .select("id, kind, weekday, on_date, start_min, end_min")
    .eq("staff_id", staffId)
    .order("kind")
    .order("weekday", { nullsFirst: true })
    .order("on_date", { nullsFirst: true })
    .order("start_min", { nullsFirst: true });
  if (error) return { error: `No se pudieron leer los horarios: ${error.message}` };
  return { rules: (data ?? []) as HourRuleRow[] };
}

/** Add one rule for a staff member. Validates the staff id and the rule shape. */
export async function addStaffHour(input: {
  staffId: string;
  draft: RuleDraft;
}): Promise<{ ok: true; rule: HourRuleRow } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const { staffId, draft } = input;
  if (!staffId) return { error: "Falta la profesional." };

  const db = serviceClient();
  if (!(await isKnownStaff(db, staffId))) {
    return { error: "Esa profesional no existe o está inactiva." };
  }

  const validated = validateRule(draft);
  if (!validated.ok) return { error: validated.error };

  const { data, error } = await db
    .from("staff_hours")
    .insert({ staff_id: staffId, ...validated.row })
    .select("id, kind, weekday, on_date, start_min, end_min")
    .single();
  if (error) return { error: `No se pudo guardar el horario: ${error.message}` };

  revalidatePath("/horarios");
  return { ok: true, rule: data as HourRuleRow };
}

/** Delete one rule by id (scoped to the staff member, defensive). */
export async function deleteStaffHour(input: {
  staffId: string;
  ruleId: string;
}): Promise<{ ok: true } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const { staffId, ruleId } = input;
  if (!staffId || !ruleId) return { error: "Faltan datos para borrar." };

  const db = serviceClient();
  const { data, error } = await db
    .from("staff_hours")
    .delete()
    .eq("id", ruleId)
    .eq("staff_id", staffId)
    .select("id");
  if (error) return { error: `No se pudo borrar: ${error.message}` };
  if (!data || data.length === 0) return { error: "No se encontró el horario." };

  revalidatePath("/horarios");
  return { ok: true };
}

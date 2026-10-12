/**
 * Staff who attend sessions — name, phone, and the Google Calendar color each
 * one gets on the mirror event. Moved from a hardcoded list to the `staff` DB
 * table (migration 20260822024448) so staff and their phone can be managed as
 * data (feature 2026-08-22): the "Quién atiende" column is editable and
 * creating a session can WhatsApp the assigned employee.
 *
 * Google Calendar exposes only 11 fixed event colors (colorId 1–11), mapped
 * from Braulio's legend:
 *   1 Lavender · 2 Sage · 3 Grape · 6 Tangerine · 8 Graphite · 9 Blueberry
 *   10 Basil. (Banana 5 "gente que cancela" is a STATE, not an employee.)
 *
 * Node-only: the CRUD form + server actions read this. The Deno calendar-write
 * function never imports it — the server action resolves the colorId and passes
 * the number across the runtime boundary.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Either the service-role client (server actions) or the session client (the
 *  page reads the staff catalog under the authenticated RLS policy). */
type Db = SupabaseClient;

export type Staff = {
  /** Stable id, = sessions.attended_by. */
  id: string;
  /** Display name in the "Quién atiende" picker (staff UI, Spanish). */
  label: string;
  /** E.164 phone for the "you were assigned" WhatsApp, or null if not loaded. */
  phone: string | null;
  /** Google Calendar event colorId (1–11), or null. */
  colorId: number | null;
};

type StaffRow = {
  id: string;
  name: string;
  phone: string | null;
  color_id: number | null;
};

function toStaff(r: StaffRow): Staff {
  return { id: r.id, label: r.name, phone: r.phone, colorId: r.color_id };
}

/** The active attending-staff catalog, ordered by name (for the picker). */
export async function fetchStaff(db: Db): Promise<Staff[]> {
  const { data, error } = await db
    .from("staff")
    .select("id, name, phone, color_id")
    .eq("active", true)
    .order("name");
  if (error || !data) return [];
  return (data as StaffRow[]).map(toStaff);
}

/** One staff row by id (or null). Used to resolve color / phone on write. */
export async function fetchStaffById(
  db: Db,
  id: string | null | undefined,
): Promise<Staff | null> {
  if (!id) return null;
  const { data } = await db
    .from("staff")
    .select("id, name, phone, color_id")
    .eq("id", id)
    .maybeSingle();
  return data ? toStaff(data as StaffRow) : null;
}

/** The colorId for an attended_by id, or null (unknown / "sin asignar" → the
 *  calendar's default color, no colorId sent). */
export async function staffColorId(
  db: Db,
  attendedBy: string | null | undefined,
): Promise<number | null> {
  const s = await fetchStaffById(db, attendedBy);
  return s?.colorId ?? null;
}

/** True if the value is a known ACTIVE staff id — the server action validates
 *  input so a stale/tampered value can't poison the row or the color lookup. */
export async function isKnownStaff(db: Db, attendedBy: string): Promise<boolean> {
  const { data } = await db
    .from("staff")
    .select("id")
    .eq("id", attendedBy)
    .eq("active", true)
    .maybeSingle();
  return data !== null;
}

"use server";

/**
 * Server Action for the DATE map on /horarios: a real
 * calendar view of a staff member's coming days — available / off / booked per
 * half-hour cell, navigable week by week. Reads their hours rules + booked
 * sessions and rasterizes via buildDateMap.
 *
 * Booked sessions are those with attended_by = the staff id, non-cancelled, not
 * dismissed. NOTE: only app-origin sessions carry attended_by (External-synced
 * calendar sessions don't), so early on the "booked" layer reflects only
 * sessions created in VAIG with a staff assigned — it fills in as the team uses
 * Nueva sesión. Availability (from the rules) shows regardless.
 */
import { serviceClient } from "../supabase/service";
import { requireStaff } from "../auth/require-staff";
import { isKnownStaff } from "../sessions/staff";
import { buildDateMap, DATE_MAP_DAYS, type DateMap } from "./date-map";
import type { HourRule, BusyInterval } from "./slots";

/**
 * The date map for a staff member starting at `fromDayKey` (YYYY-MM-DD), one
 * week wide. Never throws to the client. `fromDayKey` must be a valid day key;
 * the caller (the nav arrows) computes it.
 */
export async function fetchDateMap(input: {
  staffId: string;
  fromDayKey: string;
}): Promise<{ map: DateMap } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const { staffId, fromDayKey } = input;
  if (!staffId) return { error: "Falta la profesional." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDayKey)) {
    return { error: "Fecha inválida." };
  }

  const db = serviceClient();
  if (!(await isKnownStaff(db, staffId))) {
    return { error: "Esa profesional no existe o está inactiva." };
  }

  // Window bounds as instants for the sessions query.
  const windowStart = new Date(`${fromDayKey}T00:00:00-03:00`).toISOString();
  const windowEndMs =
    new Date(`${fromDayKey}T00:00:00-03:00`).getTime() +
    DATE_MAP_DAYS * 24 * 60 * 60 * 1000;
  const windowEnd = new Date(windowEndMs).toISOString();

  try {
    const [rulesRes, busyRes] = await Promise.all([
      db
        .from("staff_hours")
        .select("kind, weekday, on_date, start_min, end_min")
        .eq("staff_id", staffId),
      db
        .from("sessions")
        .select("starts_at, ends_at")
        .eq("attended_by", staffId)
        .neq("status", "cancelled")
        .is("dismissed_at", null)
        .lt("starts_at", windowEnd)
        // Keep NULL-end sessions (real bookings) too — the engine gives them a
        // fallback length; NULL > x would drop them.
        .or(`ends_at.gt.${windowStart},ends_at.is.null`),
    ]);

    if (rulesRes.error) throw new Error(rulesRes.error.message);
    if (busyRes.error) throw new Error(busyRes.error.message);

    const map = buildDateMap({
      fromDayKey,
      days: DATE_MAP_DAYS,
      rules: (rulesRes.data ?? []) as HourRule[],
      busy: (busyRes.data ?? []) as BusyInterval[],
    });
    return { map };
  } catch {
    return { error: "No se pudo cargar el mapa de fechas." };
  }
}

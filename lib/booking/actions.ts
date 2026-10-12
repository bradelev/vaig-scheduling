"use server";

/**
 * Server Action for the "Nueva sesión" slot helper (Phase 1C). The slot engine
 * (lib/booking/*) is Node-side, so the client form calls this to fetch a staff
 * member's free slots for a given DAY (the one chosen in the datepicker) and a
 * service duration. Purely additive: the free datetime-local stays; these are
 * optional, clickable suggestions that avoid double-booking.
 *
 * Runs as the service role (same as the other session actions) — reading hours
 * + sessions, no mutation.
 */
import { serviceClient } from "../supabase/service";
import { requireStaff } from "../auth/require-staff";
import {
  getStaffAvailability,
  type DayAvailability,
} from "./availability";
import { localDayKey } from "./slots";

/** A YYYY-MM-DD day key, or null if the string isn't one. */
function toDayKey(value: string | undefined): string | null {
  if (!value) return null;
  const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Free slots for a staff member on ONE local day (the datepicker's date), for an
 * appointment of `durationMin`. Returns that single day with its slots. Past
 * hours are dropped only when the day is today (a future day shows all its
 * slots; a past day yields none). If `dayKey` is missing/invalid we fall back to
 * today. Never throws to the client — on failure returns a message.
 */
export async function fetchStaffSlots(input: {
  staffId: string;
  durationMin: number;
  /** The chosen day (from the datepicker), "YYYY-MM-DD" or a full local string. */
  dayKey?: string;
}): Promise<{ days: DayAvailability[] } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const { staffId, durationMin } = input;
  if (!staffId) return { error: "Falta la profesional." };
  if (!Number.isFinite(durationMin) || durationMin <= 0) {
    return { error: "Duración inválida." };
  }

  const nowMs = Date.now();
  const todayKey = localDayKey(nowMs);
  const requested = toDayKey(input.dayKey);
  // A day before today has no bookable slots; clamp to today so we never query a
  // past window. Otherwise honor the requested day (today or future).
  const fromDayKey =
    requested && requested >= todayKey ? requested : todayKey;

  try {
    const db = serviceClient();
    const days = await getStaffAvailability(db, {
      staffId,
      durationMin,
      fromDayKey,
      days: 1, // just the chosen day
      nowMs,
    });
    return { days };
  } catch {
    // The helper is optional — a failure must never block manual entry.
    return { error: "No se pudieron calcular los horarios libres." };
  }
}

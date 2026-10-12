"use server";

/**
 * Server Actions for the public booking page (Phase 2). Read-only: the free
 * slots of one item for the 7 days of a week, either for a chosen
 * professional or merged across everyone who provides it ("con quien sea").
 * Runs as the service role; returns ONLY slot instants — never who is booked,
 * never another client's data (the internal booking plan, privacy rule).
 * The write is POST /api/reservar, which re-checks everything.
 *
 * Cost: one service read + one providers read + the engine's week window per
 * provider (2 reads each) — not 7 × the per-day resolver. Unauthenticated, so
 * it is also per-IP rate limited (lib/security/rate-limit).
 */
import { headers } from "next/headers";
import { clientIpFrom, hitRateLimit, RATE_LIMITS } from "../security/rate-limit";
import { serviceClient } from "../supabase/service";
import { getStaffAvailability } from "./availability";
import { mergedSlots, type Candidate } from "./priority";
import { looksLikeUuid, MAX_BOOKING_HORIZON_DAYS, withinBookingHorizon } from "./reserve";
import { addDays, dayKeyOf, weekDays } from "./public-flow";

export type WeekAvailability = {
  /** Monday of the returned week. */
  mondayKey: string;
  /** Per day: the free slot starts (ISO instants), ascending. */
  days: { dayKey: string; slots: string[] }[];
};

export async function fetchPublicWeek(input: {
  serviceId: string;
  /** The Monday of the wanted week (YYYY-MM-DD, Montevideo). */
  mondayKey: string;
  /** A specific professional, or null for "con quien sea". */
  staffId: string | null;
}): Promise<WeekAvailability | { error: string }> {
  if (!looksLikeUuid(input.serviceId)) return { error: "Servicio inválido." };
  const staffId = typeof input.staffId === "string" && input.staffId ? input.staffId : null;

  try {
    // Per-IP cap on the read (unauthenticated, service-role work behind it).
    const limited = await hitRateLimit(serviceClient(), RATE_LIMITS.publicWeek, clientIpFrom(headers()));
    if (!limited.allowed) return { error: "Demasiadas consultas seguidas. Esperá un momento y probá de nuevo." };

    // A malformed key ("2026-99-99") must be a clean error, not a RangeError.
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.mondayKey) ||
      Number.isNaN(Date.parse(`${input.mondayKey}T12:00:00-03:00`))
    ) {
      return { error: "Semana inválida." };
    }
    const keys = weekDays(input.mondayKey);

    const nowMs = Date.now();
    const todayKey = dayKeyOf(nowMs);
    const lastKey = addDays(todayKey, MAX_BOOKING_HORIZON_DAYS);
    // Only the bookable part of the week hits the DB.
    const wanted = keys.filter((k) => k >= todayKey && k <= lastKey);
    const empty = (): WeekAvailability => ({
      mondayKey: input.mondayKey,
      days: keys.map((dayKey) => ({ dayKey, slots: [] })),
    });
    if (wanted.length === 0) return empty();

    const db = serviceClient();
    const svc = await db
      .from("booking_services")
      .select("duration_min, active")
      .eq("id", input.serviceId)
      .maybeSingle();
    if (svc.error) throw new Error(svc.error.message);
    if (!svc.data || !svc.data.active) return { error: "Ese servicio ya no está disponible." };
    const durationMin = svc.data.duration_min as number;

    // Inner-join on staff so a DEACTIVATED professional's links stop offering
    // her slots — "desactivar la saca de todos lados" must hold here too, not
    // only in the name pickers.
    const prov = await db
      .from("staff_services")
      .select("staff_id, priority, staff!inner(active)")
      .eq("booking_service_id", input.serviceId)
      .eq("staff.active", true)
      .order("priority", { ascending: true });
    if (prov.error) throw new Error(prov.error.message);
    const providers = (prov.data ?? []) as { staff_id: string; priority: number }[];
    const relevant = staffId ? providers.filter((p) => p.staff_id === staffId) : providers;
    if (relevant.length === 0) return empty();

    // One window per provider covers the whole bookable span of the week.
    const fromDayKey = wanted[0];
    const days = wanted.length;
    const perProvider = await Promise.all(
      relevant.map(async (p) => ({
        staffId: p.staff_id,
        priority: p.priority,
        days: await getStaffAvailability(db, { staffId: p.staff_id, durationMin, fromDayKey, days, nowMs }),
      })),
    );

    const byDay = new Map<string, string[]>();
    for (const dayKey of wanted) {
      const candidates: Candidate[] = perProvider.map((p) => ({
        staffId: p.staffId,
        priority: p.priority,
        slots: p.days.find((d) => d.dayKey === dayKey)?.slots ?? [],
      }));
      byDay.set(
        dayKey,
        mergedSlots(candidates)
          .map((s) => s.startsAt)
          // Exact parity with the write's horizon (instant-based), so nothing
          // offered here is refused at the last step.
          .filter((iso) => withinBookingHorizon(Date.parse(iso), nowMs)),
      );
    }
    return {
      mondayKey: input.mondayKey,
      days: keys.map((dayKey) => ({ dayKey, slots: byDay.get(dayKey) ?? [] })),
    };
  } catch {
    return { error: "No pudimos cargar los horarios. Probá de nuevo." };
  }
}

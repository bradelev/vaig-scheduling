/**
 * Availability for a BOOKING SERVICE across its professionals (Phase 2 backend).
 * The public page picks a service; this enumerates the staff who provide it (by
 * priority), computes each one's free slots for a day via the single-staff
 * engine, and returns the candidates + the merged "con quien sea" slot list.
 *
 * Thin I/O over the pure engine (lib/booking/slots + availability) and the pure
 * priority logic (lib/booking/priority). Runs server-side as service_role
 * (bypasses the Phase-0 RLS) — the public read path until Phase 2's anon policy.
 * Node-only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStaffAvailability } from "./availability";
import type { Slot } from "./slots";
import { mergedSlots, type Candidate } from "./priority";

/** The service's bookable metadata the page needs. */
export type BookingService = {
  id: string;
  name: string;
  category: string | null;
  durationMin: number;
  /** Sessions included when the item is a prepaid package (cuponera); null otherwise. */
  packageSessions: number | null;
  priceUyu: number | null;
  depositUyu: number;
};

/** Why availability couldn't be computed. `not_found` is the client's problem
 *  (no such / inactive service); `read_failed` is ours (DB error). */
export type AvailabilityError = { error: string; kind: "not_found" | "read_failed" };

export type ServiceAvailability = {
  service: BookingService;
  /** Each provider + their free slots (priority order preserved). */
  candidates: Candidate[];
  /** "Con quien sea": every time ANY provider is free, ascending. */
  anySlots: Slot[];
};

/**
 * Compute a service's availability for one local day. Reads the service row,
 * its providers ordered by priority, and each provider's slots. `nowMs` drops
 * past slots on today.
 */
export async function getServiceAvailability(
  db: SupabaseClient,
  input: { serviceId: string; dayKey: string; nowMs: number; stepMin?: number },
): Promise<ServiceAvailability | AvailabilityError> {
  const { serviceId, dayKey, nowMs, stepMin } = input;

  // 1. The service (need duration_min + display fields; must be active).
  const svcRes = await db
    .from("booking_services")
    .select("id, name, category, duration_min, price_uyu, deposit_uyu, active, package_sessions")
    .eq("id", serviceId)
    .maybeSingle();
  if (svcRes.error) {
    return { error: `Could not read the service: ${svcRes.error.message}`, kind: "read_failed" };
  }
  if (!svcRes.data || !svcRes.data.active) return { error: "Service unavailable.", kind: "not_found" };
  const service: BookingService = {
    id: svcRes.data.id,
    name: svcRes.data.name,
    category: svcRes.data.category,
    durationMin: svcRes.data.duration_min,
    packageSessions: (svcRes.data.package_sessions as number | null) ?? null,
    priceUyu: svcRes.data.price_uyu,
    depositUyu: svcRes.data.deposit_uyu,
  };

  // 2. Its providers, ordered by priority (uses staff_services_by_item_idx).
  //    Inner-join on staff.active: a deactivated professional must not be
  //    offered or auto-assigned, even if her links/hours are still on file.
  const provRes = await db
    .from("staff_services")
    .select("staff_id, priority, staff!inner(active)")
    .eq("booking_service_id", serviceId)
    .eq("staff.active", true)
    .order("priority", { ascending: true });
  if (provRes.error) {
    return { error: `Could not read the providers: ${provRes.error.message}`, kind: "read_failed" };
  }
  const providers = (provRes.data ?? []) as { staff_id: string; priority: number }[];
  if (providers.length === 0) {
    return { service, candidates: [], anySlots: [] };
  }

  // 3. Each provider's free slots for the day (single-staff engine, in parallel).
  //    allSettled, not all: one provider's read failing must NOT take down the
  //    whole service page — that provider is dropped, the rest still offered.
  const settled = await Promise.allSettled(
    providers.map(async (p) => {
      const days = await getStaffAvailability(db, {
        staffId: p.staff_id,
        durationMin: service.durationMin,
        fromDayKey: dayKey,
        days: 1,
        nowMs,
        stepMin,
      });
      const slots = days[0]?.slots ?? [];
      return { staffId: p.staff_id, priority: p.priority, slots };
    }),
  );
  const candidates: Candidate[] = settled
    .filter((r): r is PromiseFulfilledResult<Candidate> => r.status === "fulfilled")
    .map((r) => r.value);

  return { service, candidates, anySlots: mergedSlots(candidates) };
}

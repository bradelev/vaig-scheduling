/**
 * Public-funnel event validation (booking analytics, docs/booking-analytics.md).
 * Pure — the anon-reachable /api/reservar/eventos endpoint accepts NOTHING that
 * doesn't validate here. Events are ANONYMOUS by design: a random browser
 * session key, never a phone or a name.
 */
import { looksLikeUuid } from "../booking/reserve";

export const FUNNEL_EVENTS = [
  "page_view",
  "service_selected",
  "staff_selected",
  "no_slots_seen",
  "slot_selected",
  "code_requested",
  "code_verified",
  "reserve_ok",
  "reserve_conflict",
  "reserve_error",
] as const;

export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];

export type TrackedEventRow = {
  session_key: string;
  event: FunnelEvent;
  booking_service_id: string | null;
  staff_id: string | null;
  week_key: string | null;
  slot_at: string | null;
};

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** Staff ids are short text slugs ("lu"); bound them hard. */
const STAFF_ID = /^[a-z0-9]{1,40}$/;

/**
 * Validate the wire shape `{ k, e, s?, st?, w?, t? }` into an insert row.
 * Unknown events, malformed ids and out-of-shape extras are rejected — the
 * table's CHECK would too, but a clean 400 beats a Postgres error, and the
 * endpoint must never forward junk.
 */
export function validateTrackedEvent(input: unknown): { ok: true; row: TrackedEventRow } | { error: string } {
  const raw = (input ?? {}) as Record<string, unknown>;

  const key = typeof raw.k === "string" ? raw.k : "";
  if (!looksLikeUuid(key)) return { error: "bad session key" };

  const event = typeof raw.e === "string" ? raw.e : "";
  if (!(FUNNEL_EVENTS as readonly string[]).includes(event)) return { error: "bad event" };

  let serviceId: string | null = null;
  if (raw.s !== undefined && raw.s !== null) {
    if (typeof raw.s !== "string" || !looksLikeUuid(raw.s)) return { error: "bad service" };
    serviceId = raw.s;
  }

  let staffId: string | null = null;
  if (raw.st !== undefined && raw.st !== null) {
    if (typeof raw.st !== "string" || !STAFF_ID.test(raw.st)) return { error: "bad staff" };
    staffId = raw.st;
  }

  let weekKey: string | null = null;
  if (raw.w !== undefined && raw.w !== null) {
    if (typeof raw.w !== "string" || !DAY_KEY.test(raw.w) || Number.isNaN(Date.parse(`${raw.w}T12:00:00Z`))) {
      return { error: "bad week" };
    }
    weekKey = raw.w;
  }

  let slotAt: string | null = null;
  if (raw.t !== undefined && raw.t !== null) {
    if (typeof raw.t !== "string" || Number.isNaN(Date.parse(raw.t))) return { error: "bad slot" };
    slotAt = new Date(raw.t).toISOString();
  }

  return {
    ok: true,
    row: {
      session_key: key,
      event: event as FunnelEvent,
      booking_service_id: serviceId,
      staff_id: staffId,
      week_key: weekKey,
      slot_at: slotAt,
    },
  };
}

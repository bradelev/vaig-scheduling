/**
 * Public reservation WRITE logic (Phase 2). Given a phone-verified client, a
 * service, a chosen slot and (optionally) a chosen professional, decide who
 * attends and what session row to write — then insert it, relying on the DB
 * exclusion constraint (sessions_no_overlap) for atomic double-booking safety.
 * I/O is injected as ports so this is unit-tested; the route wires the real DB.
 *
 * The security-critical rule: the CLIENT is identified by their verified-phone
 * session, NEVER by client-supplied input. Identity is a separate argument with
 * a branded type only the route's JWT read constructs — a spread of the request
 * body can't reach it. Everything the client may choose (service, slot,
 * professional, their own name for a first booking) travels in `request`.
 *
 * The reservation is born "por confirmar" (pending_confirmation = true): it
 * blocks the slot and shows on the agenda, but is not reminded nor mirrored to
 * Google Calendar until staff confirm it (see migration pending_confirmation).
 */
import { assignByPriority, staffHasSlot, type Candidate } from "./priority";
import { isPackageItem, packageRemaining } from "./packages";
import { categoryToSlug } from "./service-category";

/**
 * A phone that came from a VERIFIED session (JWT app_metadata.phone), not from
 * request input. Branded so a plain string — e.g. a body field — can't be
 * passed as identity by accident. Construct ONLY with verifiedPhone() at the
 * point where the JWT was validated.
 */
export type VerifiedPhone = string & { readonly __brand: "VerifiedPhone" };

/** Mark a phone as verified. Call ONLY right after supabase.auth.getUser(). */
export function verifiedPhone(phoneFromJwt: string): VerifiedPhone {
  return phoneFromJwt as VerifiedPhone;
}

/**
 * A client may hold at most this many FUTURE reservations still waiting for
 * staff confirmation. Beyond it, they must wait for the team to confirm (or
 * cancel) before booking more — a verified phone can't fill the agenda with
 * pending slots.
 */
export const MAX_PENDING_RESERVATIONS = 3;

/** How far ahead a client may reserve. Weekly hour rules would otherwise yield
 *  slots for any future date (a slot in 2099 is "free"). */
export const MAX_BOOKING_HORIZON_DAYS = 60;

/** Longest client name stored on a first booking. */
export const MAX_CLIENT_NAME_LENGTH = 80;

/**
 * Name stored for a client who books online without giving a name. Neutral,
 * operator-fillable, never derived from input. Anything that renders a name
 * (staff notice, client notice) treats it as "no name".
 */
export const PLACEHOLDER_CLIENT_NAME = "Cliente (reserva online)";

/** True when a start instant is in the future and within the booking horizon. */
export function withinBookingHorizon(startMs: number, nowMs: number): boolean {
  if (!Number.isFinite(startMs)) return false;
  return startMs > nowMs && startMs <= nowMs + MAX_BOOKING_HORIZON_DAYS * 86_400_000;
}

/** Shape check for a booking_services id (uuid) — so a malformed id is the
 *  client's 400, not a Postgres 22P02 surfacing as our 500. */
export function looksLikeUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Clean a client-typed name for storage + WhatsApp params: drop control and
 * format characters (NUL breaks Postgres; zero-width/bidi marks are invisible
 * spoofing), collapse whitespace (Meta rejects newlines/tabs in params), bound
 * the length by code points (never split a surrogate pair). Empty → null.
 */
export function cleanClientName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Explicit ranges (the TS target is ES5, so no \p{..}/u): C0+C1 controls,
  // soft hyphen, Arabic letter mark, zero-width + bidi marks, word joiners, BOM.
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f-\x9f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = Array.from(cleaned).slice(0, MAX_CLIENT_NAME_LENGTH).join("").trim();
  return bounded || null;
}

/**
 * Thrown by the insertSession port ONLY when the sessions_no_overlap exclusion
 * constraint fires — the slot was taken in the same instant. The port (which
 * knows it's Postgres) maps SQLSTATE 23P01 to this; the pure logic must not
 * sniff SQL error shapes. Any OTHER error propagates as a real failure.
 */
export class SlotTakenError extends Error {
  constructor() {
    super("slot taken");
    this.name = "SlotTakenError";
  }
}

export type ReservePorts = {
  /** The service (authoritative name/category/duration from the DB) + its
   *  providers with their free slots for the chosen day (priority order).
   *  null ONLY when the service doesn't exist or is inactive; a read failure
   *  must throw (it is not "invalid service"). */
  serviceAvailability(
    serviceId: string,
    dayKey: string,
  ): Promise<{
    name: string;
    category: string | null;
    durationMin: number;
    /** Sessions in the item when it's a prepaid package (cuponera); null otherwise. */
    packageSessions: number | null;
    candidates: Candidate[];
  } | null>;
  /** Find-or-create the client row for this VERIFIED phone. `nameIfNew` is
   *  used only when creating; an existing client's name is never overwritten.
   *  Returns the id and the name on file (null when nothing usable). */
  clientForPhone(
    phone: VerifiedPhone,
    nameIfNew: string | null,
  ): Promise<{ id: string; name: string | null }>;
  /** How many FUTURE reservations of this client still await staff
   *  confirmation (pending_confirmation = true, status scheduled). */
  pendingReservationCount(clientId: string): Promise<number>;
  /** Atomically take ONE credit from the client's oldest open package of this
   *  item, or — when they have none — create the package (first purchase,
   *  used = 1, pendiente_pago) IN THE SAME SERIALIZED STEP. Two concurrent
   *  callers can never both create (DB advisory lock per client+service);
   *  `created` tells the compensation path whether to delete the package or
   *  refund the credit. */
  takePackageCredit(
    clientId: string,
    serviceId: string,
    totalSessions: number,
  ): Promise<{ id: string; total: number; used: number; created: boolean }>;
  /** Give ONE credit back (the reservation that took it failed). */
  refundCredit(packageId: string): Promise<void>;
  /** Remove a package that was just created for a reservation that failed.
   *  false when it no longer matches (a concurrent booking already drew from
   *  it) — the caller then refunds this attempt's credit instead. */
  deletePackage(packageId: string): Promise<boolean>;
  /** Insert the session. Throws SlotTakenError when the exclusion constraint
   *  fires (the slot was taken in the same instant); any other throw is a real
   *  failure and propagates. */
  insertSession(row: {
    clientId: string;
    attendedBy: string;
    startsAt: string;
    endsAt: string;
    service: string | null;
    note: string | null;
    /** Always true here: a public reservation is born "por confirmar". */
    pendingConfirmation: true;
    /** The catalog item booked (sessions.booking_service_id). */
    bookingServiceId: string;
    /** The package this session drew its credit from (sessions.package_id). */
    packageId: string | null;
  }): Promise<{ sessionId: string }>;
  /** Notify the assigned professional (best-effort — never fails the booking). */
  notifyStaff(input: {
    staffId: string;
    clientName: string | null;
    serviceName: string;
    startsAt: string;
  }): Promise<void>;
};

/** What the client chooses. NOTHING here identifies the client. */
export type ReserveRequest = {
  serviceId: string;
  /** The chosen slot start (canonical ISO instant). */
  startsAt: string;
  /** The chosen day (YYYY-MM-DD, Montevideo) — for the availability lookup. */
  dayKey: string;
  /** A specific professional (direct choice), or null for "con quien sea". */
  staffId: string | null;
  /** The client's own name, used ONLY if they don't exist as a client yet. */
  clientName: string | null;
};

export type ReserveIdentity = { phone: VerifiedPhone };

export type ReserveResult =
  | {
      ok: true;
      sessionId: string;
      attendedBy: string;
      /** Present when the item is a cuponera: the balance after this booking. */
      package?: { id: string; total: number; remaining: number };
    }
  | { ok: false; reason: "unavailable" | "taken" | "invalid" | "limit" };

/**
 * Reserve a slot. Re-checks availability (never trusts the client that the slot
 * is free), assigns the professional, caps pending reservations per client,
 * and inserts — the DB constraint is the final atomic guard against a
 * same-instant double-book.
 */
export async function reserve(
  identity: ReserveIdentity,
  request: ReserveRequest,
  ports: ReservePorts,
): Promise<ReserveResult> {
  const avail = await ports.serviceAvailability(request.serviceId, request.dayKey);
  if (!avail) return { ok: false, reason: "invalid" };

  // Decide who attends. Both paths require startsAt to match a computed slot
  // EXACTLY (canonical ISO), so a malformed instant can never reach the Date
  // math below — it is simply "not a free slot".
  let attendedBy: string | null;
  if (request.staffId) {
    // Direct choice: honor only if that professional provides the service AND
    // is actually free then (a staffId outside the candidates is not found).
    attendedBy = staffHasSlot(avail.candidates, request.staffId, request.startsAt)
      ? request.staffId
      : null;
  } else {
    // "Con quien sea": first free by priority.
    attendedBy = assignByPriority(avail.candidates, request.startsAt);
  }
  if (!attendedBy) return { ok: false, reason: "unavailable" };

  const client = await ports.clientForPhone(identity.phone, request.clientName);
  // Soft anti-spam cap: read-then-insert, so two concurrent requests can both
  // pass and land one over the cap. Accepted — it bounds abuse, it is not an
  // invariant (no DB-level enforcement by design).
  if ((await ports.pendingReservationCount(client.id)) >= MAX_PENDING_RESERVATIONS) {
    return { ok: false, reason: "limit" };
  }

  const endsAt = new Date(
    new Date(request.startsAt).getTime() + avail.durationMin * 60_000,
  ).toISOString();
  // Map the booking item's category to a service_types slug (or null) so the
  // validate_app_service trigger accepts the row; the exact item (the DB's
  // name — never the client's text) goes in the note.
  const service = categoryToSlug(avail.category);
  const note = `Reserva online: ${avail.name}`;

  // Cuponera: this reservation draws one credit. Existing balance first
  // (atomic take); otherwise this is the purchase — the package is born with
  // its first credit used, pending payment (the team marks it paid on day 1).
  let pkg: { id: string; total: number; used: number; created: boolean } | null = null;
  if (isPackageItem(avail.packageSessions)) {
    pkg = await ports.takePackageCredit(client.id, request.serviceId, avail.packageSessions);
  }

  let sessionId: string;
  try {
    const res = await ports.insertSession({
      clientId: client.id,
      attendedBy,
      startsAt: request.startsAt,
      endsAt,
      service,
      note,
      pendingConfirmation: true,
      bookingServiceId: request.serviceId,
      packageId: pkg?.id ?? null,
    });
    sessionId = res.sessionId;
  } catch (err) {
    // The credit was taken for a session that doesn't exist: give it back
    // (or drop the package this attempt created). Best-effort. Known residual
    // (accepted): the take and this insert are separate transactions, so a
    // client racing HERSELF on the very last credit AND losing the slot can
    // leave a phantom pendiente_pago package — staff-visible and correctable
    // from the Cuponeras panel.
    if (pkg) {
      try {
        const dropped = pkg.created ? await ports.deletePackage(pkg.id) : false;
        if (!dropped) await ports.refundCredit(pkg.id);
      } catch {
        // The original error is the one to report.
      }
    }
    // Only the exclusion-constraint violation means "slot taken". Any other
    // error (RLS denial, connection drop, a bug) must propagate — reporting it
    // as "taken" would hide a real failure behind a misleading message.
    if (err instanceof SlotTakenError) return { ok: false, reason: "taken" };
    throw err;
  }

  // Best-effort: notify the assigned professional. Never fails the booking.
  try {
    await ports.notifyStaff({
      staffId: attendedBy,
      clientName: client.name,
      serviceName: avail.name,
      startsAt: request.startsAt,
    });
  } catch {
    // Swallow — the reservation stands even if the notice didn't send.
  }

  return {
    ok: true,
    sessionId,
    attendedBy,
    ...(pkg ? { package: { id: pkg.id, total: pkg.total, remaining: packageRemaining(pkg) } } : {}),
  };
}

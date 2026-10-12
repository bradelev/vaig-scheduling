/**
 * Real I/O ports for the public reservation write (Phase 2). Implements the
 * ReservePorts interface against Supabase (service role) + the staff WhatsApp
 * notify. Thin by design — all decisions live in reserve.ts. Node-only (uses
 * the service-role client and process.env).
 *
 * Runs as service_role: the public booking path has no per-client RLS policy of
 * its own yet (Phase-0 RLS is staff/client-owns-own), so the write goes through
 * the trusted server after the route has verified the caller's phone from the
 * JWT. The client is NEVER identified by request input — the route passes the
 * verified phone (branded VerifiedPhone), and clientForPhone resolves it here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "../supabase/service";
import { getServiceAvailability } from "./service-availability";
import { notifyNewReservation } from "./notify-staff";
import { PLACEHOLDER_CLIENT_NAME, SlotTakenError, type ReservePorts } from "./reserve";

/** Postgres SQLSTATE for an exclusion-constraint violation (sessions_no_overlap). */
const EXCLUSION_VIOLATION = "23P01";
/** Postgres SQLSTATE for a unique violation (clients.phone on a create race). */
const UNIQUE_VIOLATION = "23505";

export { PLACEHOLDER_CLIENT_NAME };

/**
 * Build the real ports. `nowMs` is read here (past-slot trimming in the
 * availability read, the "future" bound of the pending count) so the route
 * stays declarative.
 */
export function makeReservePorts(opts: { nowMs: number }): ReservePorts {
  const db = serviceClient();

  return {
    async serviceAvailability(serviceId, dayKey) {
      const res = await getServiceAvailability(db, {
        serviceId,
        dayKey,
        nowMs: opts.nowMs,
      });
      if ("error" in res) {
        // Only "no such / inactive service" is the client's problem. A failed
        // read is OUR failure and must not be reported as an invalid service.
        if (res.kind === "not_found") return null;
        throw new Error(`serviceAvailability: ${res.error}`);
      }
      return {
        name: res.service.name,
        category: res.service.category,
        durationMin: res.service.durationMin,
        packageSessions: res.service.packageSessions,
        candidates: res.candidates,
      };
    },

    async clientForPhone(phone, nameIfNew) {
      const found = await selectClient(db, phone);
      if (found) return found;

      // Not a client yet (they logged in by phone, never had a session):
      // create a minimal row so the reservation has an identity. The name is
      // the one they typed (already trimmed/bounded by the route) or the
      // placeholder — an EXISTING client's name is never touched.
      const created = await db
        .from("clients")
        .insert({ full_name: nameIfNew ?? PLACEHOLDER_CLIENT_NAME, phone })
        .select("id")
        .single();
      if (created.error) {
        // Two first-time reservations for the same phone in the same instant:
        // the other insert won the unique constraint — read the row it made.
        if (created.error.code === UNIQUE_VIOLATION) {
          const again = await selectClient(db, phone);
          if (again) return again;
        }
        throw new Error(`clientForPhone insert: ${created.error.message}`);
      }
      return { id: created.data.id as string, name: nameIfNew };
    },

    async pendingReservationCount(clientId) {
      const res = await db
        .from("sessions")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .eq("pending_confirmation", true)
        .eq("status", "scheduled")
        .gte("starts_at", new Date(opts.nowMs).toISOString());
      if (res.error) throw new Error(`pendingReservationCount: ${res.error.message}`);
      return res.count ?? 0;
    },

    async takePackageCredit(clientId, serviceId, totalSessions) {
      // One serialized DB step: consume from the oldest open package or create
      // the first-purchase package — the advisory lock inside the RPC is what
      // stops two concurrent purchases from both creating (migration
      // package_credit_integrity).
      const res = await db.rpc("take_package_credit", {
        p_client: clientId,
        p_service: serviceId,
        p_total: totalSessions,
      });
      if (res.error) throw new Error(`takePackageCredit: ${res.error.message}`);
      const row = (Array.isArray(res.data) ? res.data[0] : res.data) as
        | { id: string; total_sessions: number; used_sessions: number; created: boolean }
        | undefined;
      if (!row) throw new Error("takePackageCredit: empty result");
      return { id: row.id, total: row.total_sessions, used: row.used_sessions, created: row.created };
    },

    async refundCredit(packageId) {
      const res = await db.rpc("adjust_package_credit", { p_package: packageId, p_delta: -1 });
      if (res.error) throw new Error(`refundCredit: ${res.error.message}`);
    },

    async deletePackage(packageId) {
      // Only a package nothing else drew from yet (the session insert failed).
      const res = await db
        .from("client_packages")
        .delete()
        .eq("id", packageId)
        .eq("used_sessions", 1)
        .select("id");
      if (res.error) throw new Error(`deletePackage: ${res.error.message}`);
      return (res.data ?? []).length > 0;
    },

    async insertSession(row) {
      // Mirror the v3 CRUD insert (lib/sessions/actions.ts): source='app',
      // gcal_event_id NULL (a "por confirmar" reservation isn't mirrored until
      // staff confirm), status 'scheduled'. pending_confirmation marks it as
      // awaiting STAFF confirmation — distinct from confirmed_at, which the
      // client sets by answering the reminder (see migration pending_confirmation).
      const { data, error } = await db
        .from("sessions")
        .insert({
          source: "app",
          client_id: row.clientId,
          attended_by: row.attendedBy,
          starts_at: row.startsAt,
          ends_at: row.endsAt,
          service: row.service,
          note: row.note,
          status: "scheduled",
          gcal_event_id: null,
          pending_confirmation: row.pendingConfirmation,
          booking_service_id: row.bookingServiceId,
          package_id: row.packageId,
        })
        .select("id")
        .single();
      if (error) {
        // The exclusion constraint fired → the slot was taken in the same
        // instant. Only THIS becomes "taken"; any other error propagates.
        if (isExclusionViolation(error)) throw new SlotTakenError();
        throw new Error(`insertSession: ${error.message}`);
      }
      return { sessionId: data.id as string };
    },

    async notifyStaff(input) {
      await notifyNewReservation(db, input);
    },
  };
}

/**
 * The display name a phone maps to, or null (unknown client, or only the
 * placeholder on file). Show it ONLY to someone who proved ownership of that
 * phone (cookie session or a just-verified code) — never to unauthenticated
 * input, or it becomes a phone→name oracle.
 */
export async function clientNameByPhone(
  db: SupabaseClient,
  phone: string,
): Promise<string | null> {
  const name = (await selectClient(db, phone))?.name?.trim();
  return name || null;
}

/** The client row for a phone, with the placeholder name reported as null. */
async function selectClient(
  db: SupabaseClient,
  phone: string,
): Promise<{ id: string; name: string | null } | null> {
  const res = await db
    .from("clients")
    .select("id, full_name")
    .eq("phone", phone)
    .maybeSingle();
  if (res.error) throw new Error(`clientForPhone: ${res.error.message}`);
  if (!res.data) return null;
  const name = (res.data.full_name as string | null) ?? null;
  return {
    id: res.data.id as string,
    name: name && name !== PLACEHOLDER_CLIENT_NAME ? name : null,
  };
}

/** True when a PostgREST error is the sessions_no_overlap exclusion violation. */
export function isExclusionViolation(error: { code?: string; message?: string }): boolean {
  if (error.code === EXCLUSION_VIOLATION) return true;
  // PostgREST doesn't always surface the raw SQLSTATE; fall back to the
  // constraint name in the message (stable — defined in the migration).
  return Boolean(error.message && error.message.includes("sessions_no_overlap"));
}

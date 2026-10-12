/**
 * Read the public reservations awaiting STAFF confirmation
 * (sessions.pending_confirmation = true, still scheduled) for the panel.
 * Server-side; runs with the caller's client (staff RLS on the cookie client
 * or the service role) — the caller passes it in.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PendingReservation } from "./pending-format";

/** PostgREST nests a many-to-one embed as an object; the generic types may say
 *  array. Accept both. */
function one<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

type Row = {
  id: string;
  starts_at: string;
  ends_at: string | null;
  service: string | null;
  note: string | null;
  attended_by: string | null;
  created_at: string;
  clients: { full_name: string; phone: string | null } | { full_name: string; phone: string | null }[] | null;
  booking_services: { name: string } | { name: string }[] | null;
  client_packages:
    | { total_sessions: number; used_sessions: number; status: string }
    | { total_sessions: number; used_sessions: number; status: string }[]
    | null;
};

export async function fetchPendingReservations(
  db: SupabaseClient,
  nowMs: number,
): Promise<{ items: PendingReservation[] } | { error: string }> {
  const res = await db
    .from("sessions")
    .select(
      "id, starts_at, ends_at, service, note, attended_by, created_at, clients(full_name, phone), booking_services(name), client_packages(total_sessions, used_sessions, status)",
    )
    .eq("pending_confirmation", true)
    .eq("status", "scheduled")
    .order("starts_at", { ascending: true });
  if (res.error) return { error: res.error.message };

  const items = ((res.data ?? []) as Row[]).map((r): PendingReservation => {
    const client = one(r.clients);
    const item = one(r.booking_services);
    return {
      id: r.id,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      clientName: client?.full_name ?? "(sin nombre)",
      clientPhone: client?.phone ?? null,
      serviceName: item?.name ?? r.note ?? r.service ?? "(sin servicio)",
      staffId: r.attended_by,
      createdAt: r.created_at,
      stale: new Date(r.starts_at).getTime() < nowMs,
      pkg: (() => {
        const cp = one(r.client_packages);
        return cp
          ? { total: cp.total_sessions, used: cp.used_sessions, unpaid: cp.status === "pendiente_pago" }
          : null;
      })(),
    };
  });
  return { items };
}

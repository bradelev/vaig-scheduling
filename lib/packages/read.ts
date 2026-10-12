/**
 * Cuponera (prepaid package) reads. Server-side only.
 *  - fetchOpenPackages: the staff panel list (every non-cancelled package,
 *    newest first) with client + item names.
 *  - fetchClientBalances: what a verified client still has to book — used by
 *    the public page (service role, keyed by the VERIFIED phone).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PackageStatus } from "../booking/packages";

function one<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export type PackageRow = {
  id: string;
  clientId: string;
  clientName: string;
  clientPhone: string | null;
  serviceId: string;
  serviceName: string;
  total: number;
  used: number;
  status: PackageStatus;
  paidAt: string | null;
  createdAt: string;
};

type Raw = {
  id: string;
  client_id: string;
  booking_service_id: string;
  total_sessions: number;
  used_sessions: number;
  status: PackageStatus;
  paid_at: string | null;
  created_at: string;
  clients: { full_name: string; phone: string | null } | { full_name: string; phone: string | null }[] | null;
  booking_services: { name: string } | { name: string }[] | null;
};

const SELECT =
  "id, client_id, booking_service_id, total_sessions, used_sessions, status, paid_at, created_at, clients(full_name, phone), booking_services(name)";

function toRow(r: Raw): PackageRow {
  const c = one(r.clients);
  const s = one(r.booking_services);
  return {
    id: r.id,
    clientId: r.client_id,
    clientName: c?.full_name ?? "(sin nombre)",
    clientPhone: c?.phone ?? null,
    serviceId: r.booking_service_id,
    serviceName: s?.name ?? "(ítem retirado)",
    total: r.total_sessions,
    used: r.used_sessions,
    status: r.status,
    paidAt: r.paid_at,
    createdAt: r.created_at,
  };
}

export async function fetchOpenPackages(
  db: SupabaseClient,
): Promise<{ rows: PackageRow[] } | { error: string }> {
  const res = await db
    .from("client_packages")
    .select(SELECT)
    .neq("status", "cancelada")
    .order("created_at", { ascending: false });
  if (res.error) return { error: res.error.message };
  // "Open" = still needs something from the team: credit left, or payment.
  // A paid package with every session used is done and leaves the list.
  return {
    rows: ((res.data ?? []) as Raw[])
      .map(toRow)
      .filter((r) => !(r.status === "pagada" && r.used >= r.total)),
  };
}

export type ClientBalance = {
  packageId: string;
  serviceId: string;
  serviceName: string;
  total: number;
  used: number;
};

/** Open packages WITH credit left for the client with this (verified) phone. */
export async function fetchClientBalances(db: SupabaseClient, phone: string): Promise<ClientBalance[]> {
  const client = await db.from("clients").select("id").eq("phone", phone).maybeSingle();
  if (client.error || !client.data) return [];
  const res = await db
    .from("client_packages")
    .select("id, booking_service_id, total_sessions, used_sessions, booking_services(name)")
    .eq("client_id", client.data.id as string)
    .neq("status", "cancelada")
    .order("created_at", { ascending: true });
  if (res.error) return [];
  return ((res.data ?? []) as Pick<Raw, "id" | "booking_service_id" | "total_sessions" | "used_sessions" | "booking_services">[])
    .filter((r) => r.used_sessions < r.total_sessions)
    .map((r) => ({
      packageId: r.id,
      serviceId: r.booking_service_id,
      serviceName: one(r.booking_services)?.name ?? "(ítem retirado)",
      total: r.total_sessions,
      used: r.used_sessions,
    }));
}

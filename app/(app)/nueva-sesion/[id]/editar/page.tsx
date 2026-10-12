/**
 * Edit an existing app-origin session (PRD Part II §II.2, issue #117 — the
 * edit half of create/edit). Loads the one session + the service catalog
 * server-side, then hands them to a client component that calls editSession /
 * moveSession / cancelSession. Only app-origin sessions are editable here —
 * external/manual sessions belong to the cascade, not the CRUD.
 */
import { notFound } from "next/navigation";
import { createClient, hasSupabaseEnv } from "@/lib/supabase/server";
import EditarSesion from "./EditarSesion";
import type { ServiceType } from "../../page";

export const dynamic = "force-dynamic";

export type EditableSession = {
  id: string;
  starts_at: string;
  ends_at: string | null;
  service: string | null;
  note: string | null;
  status: string;
  client_name: string;
};

export default async function EditarSesionPage({
  params,
}: {
  params: { id: string };
}) {
  if (!hasSupabaseEnv()) {
    return (
      <main className="wrap">
        <p>Configuración pendiente.</p>
      </main>
    );
  }
  const db = createClient();

  const [{ data: session }, { data: services }] = await Promise.all([
    db
      .from("sessions")
      .select("id, starts_at, ends_at, service, note, status, clients(full_name)")
      .eq("id", params.id)
      .eq("source", "app")
      .maybeSingle(),
    db
      .from("service_types")
      .select("slug, label")
      .eq("active", true)
      .order("sort_order"),
  ]);

  if (!session) notFound();

  const editable: EditableSession = {
    id: session.id,
    starts_at: session.starts_at,
    ends_at: session.ends_at,
    service: session.service,
    note: session.note,
    status: session.status,
    client_name:
      (session.clients as { full_name?: string } | null)?.full_name ?? "",
  };

  return (
    <EditarSesion session={editable} services={(services as ServiceType[]) ?? []} />
  );
}

/**
 * Profesionales — the staff catalog (staff, staff_services) CRUD: who shows up
 * on the public booking page and in the app's staff pickers. Deactivating a
 * professional pulls her out of everything without deleting her history; her
 * working hours are loaded separately, in Horarios.
 */
import { createClient, hasSupabaseEnv } from "@/lib/supabase/server";
import { ErrorBanner } from "@/app/(app)/_components/Banners";
import { ProfesionalesPanel } from "./ProfesionalesPanel";

export const dynamic = "force-dynamic";

export type ProfessionalRow = {
  id: string;
  name: string;
  phone: string | null;
  colorId: number | null;
  active: boolean;
  serviceIds: string[];
  priority: number | null;
};

export type CatalogServiceOption = {
  id: string;
  name: string;
  category: string | null;
};

export default async function ProfesionalesPage() {
  if (!hasSupabaseEnv()) {
    return <p>La app no está configurada todavía.</p>;
  }
  const supabase = createClient();
  const [staff, links, services] = await Promise.all([
    supabase.from("staff").select("id, name, phone, color_id, active").order("name"),
    supabase.from("staff_services").select("staff_id, booking_service_id, priority"),
    supabase
      .from("booking_services")
      .select("id, name, category")
      .eq("active", true)
      .order("category")
      .order("name"),
  ]);

  const linkRows = (links.data ?? []) as { staff_id: string; booking_service_id: string; priority: number }[];
  const linksByStaff = new Map<string, { serviceIds: string[]; priorities: number[] }>();
  for (const link of linkRows) {
    const entry = linksByStaff.get(link.staff_id) ?? { serviceIds: [], priorities: [] };
    entry.serviceIds.push(link.booking_service_id);
    entry.priorities.push(link.priority);
    linksByStaff.set(link.staff_id, entry);
  }

  const rows: ProfessionalRow[] = (
    (staff.data ?? []) as { id: string; name: string; phone: string | null; color_id: number | null; active: boolean }[]
  ).map((s) => {
    const entry = linksByStaff.get(s.id);
    return {
      id: s.id,
      name: s.name,
      phone: s.phone,
      colorId: s.color_id,
      active: s.active,
      serviceIds: entry?.serviceIds ?? [],
      priority: entry && entry.priorities.length > 0 ? Math.min(...entry.priorities) : null,
    };
  });

  const serviceOptions: CatalogServiceOption[] = (
    (services.data ?? []) as { id: string; name: string; category: string | null }[]
  ).map((s) => ({ id: s.id, name: s.name, category: s.category }));

  return (
    <section>
      <h2 style={{ fontSize: 20, margin: "18px 0 4px" }}>Profesionales</h2>
      <p style={{ color: "#5b6169", fontSize: 14, margin: "0 0 16px" }}>
        Quién aparece en la página de reservas pública y en los selectores de la app. Desactivar a una
        profesional la saca de todos lados sin borrar su historial. Los horarios se cargan aparte, en
        Horarios.
      </p>
      {staff.error ? (
        <ErrorBanner>No se pudieron cargar las profesionales: {staff.error.message}</ErrorBanner>
      ) : (
        <ProfesionalesPanel rows={rows} serviceOptions={serviceOptions} />
      )}
      {links.error ? <ErrorBanner>No se pudieron cargar los servicios asignados: {links.error.message}</ErrorBanner> : null}
      {services.error ? <ErrorBanner>No se pudo cargar el catálogo: {services.error.message}</ErrorBanner> : null}
    </section>
  );
}

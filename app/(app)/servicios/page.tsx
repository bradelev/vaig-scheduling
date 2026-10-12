/**
 * Servicios — the service catalog (booking_services) CRUD. This is the same
 * catalog the public booking page and Nueva sesión read from: deactivating a
 * service hides it everywhere without deleting its history (sessions and
 * client_packages keep their reference).
 */
import { createClient, hasSupabaseEnv } from "@/lib/supabase/server";
import { ErrorBanner } from "@/app/(app)/_components/Banners";
import { ServiciosPanel } from "./ServiciosPanel";

export const dynamic = "force-dynamic";

export type ServiceRow = {
  id: string;
  name: string;
  category: string | null;
  durationMin: number;
  priceUyu: number | null;
  packageSessions: number | null;
  active: boolean;
  providerCount: number;
};

export default async function ServiciosPage() {
  if (!hasSupabaseEnv()) {
    return <p>La app no está configurada todavía.</p>;
  }
  const supabase = createClient();
  const [services, links] = await Promise.all([
    supabase
      .from("booking_services")
      .select("id, name, category, duration_min, price_uyu, package_sessions, active")
      .order("category", { ascending: true, nullsFirst: false })
      .order("sort_order")
      .order("name"),
    supabase.from("staff_services").select("booking_service_id"),
  ]);

  const providerCounts = new Map<string, number>();
  for (const link of (links.data ?? []) as { booking_service_id: string }[]) {
    providerCounts.set(link.booking_service_id, (providerCounts.get(link.booking_service_id) ?? 0) + 1);
  }

  const rows: ServiceRow[] = (
    (services.data ?? []) as {
      id: string;
      name: string;
      category: string | null;
      duration_min: number;
      price_uyu: number | null;
      package_sessions: number | null;
      active: boolean;
    }[]
  ).map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    durationMin: s.duration_min,
    priceUyu: s.price_uyu,
    packageSessions: s.package_sessions,
    active: s.active,
    providerCount: providerCounts.get(s.id) ?? 0,
  }));

  return (
    <section>
      <h2 style={{ fontSize: 20, margin: "18px 0 4px" }}>Servicios</h2>
      <p style={{ color: "#5b6169", fontSize: 14, margin: "0 0 16px" }}>
        Este catálogo alimenta la página de reservas pública y Nueva sesión. Desactivar un servicio lo
        oculta en todos lados sin borrar su historial.
      </p>
      {services.error ? (
        <ErrorBanner>No se pudieron cargar los servicios: {services.error.message}</ErrorBanner>
      ) : (
        <ServiciosPanel rows={rows} />
      )}
      {links.error ? <ErrorBanner>No se pudieron cargar las profesionales asignadas: {links.error.message}</ErrorBanner> : null}
    </section>
  );
}

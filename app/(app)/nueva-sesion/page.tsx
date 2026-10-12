/**
 * "Nueva sesión" — the structured create screen that replaces free-text in the
 * calendar (PRD Part II §II.2, issue #117). The service-category catalog (~7
 * rows) loads server-side so the form renders instantly; the ~1300-row client
 * list is NO LONGER awaited here (it made the screen "feel dead" on click) —
 * NuevaSesion fetches it in the background via fetchClientsForPicker and filters
 * locally once it arrives. The UX constraint is non-negotiable: creating a
 * session must not cost more than a Google Calendar event — target <15s.
 */
import { createClient, hasSupabaseEnv } from "@/lib/supabase/server";
import { fetchStaff, type Staff } from "@/lib/sessions/staff";
import NuevaSesion from "./NuevaSesion";

export const dynamic = "force-dynamic";

export type ServiceType = { slug: string; label: string };
export type { Staff };

export default async function NuevaSesionPage() {
  if (!hasSupabaseEnv()) {
    return (
      <main className="wrap">
        <p>Configuración pendiente.</p>
      </main>
    );
  }
  const db = createClient();

  // Only the tiny service catalog is awaited — the form is usable immediately;
  // clients stream in behind it.
  const [{ data: services }, staff] = await Promise.all([
    db
      .from("service_types")
      .select("slug, label")
      .eq("active", true)
      .order("sort_order"),
    fetchStaff(db),
  ]);

  return (
    <NuevaSesion
      services={(services as ServiceType[]) ?? []}
      staff={staff}
    />
  );
}

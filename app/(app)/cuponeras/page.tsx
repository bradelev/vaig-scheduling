/**
 * Cuponeras (prepaid packages) panel: every open package with its balance
 * and payment state; mark paid on day 1, take / return a credit by hand,
 * void, and load one manually (sold before VAIG or at the desk).
 */
import { createClient, hasSupabaseEnv } from "@/lib/supabase/server";
import { fetchOpenPackages } from "@/lib/packages/read";
import { ErrorBanner } from "@/app/(app)/_components/Banners";
import { PackagesPanel } from "./PackagesPanel";

export const dynamic = "force-dynamic";

export default async function CuponerasPage() {
  if (!hasSupabaseEnv()) {
    return <p>La app no está configurada todavía.</p>;
  }
  const supabase = createClient();
  const [packages, items] = await Promise.all([
    fetchOpenPackages(supabase),
    supabase
      .from("booking_services")
      .select("id, name, package_sessions")
      .eq("active", true)
      .not("package_sessions", "is", null)
      .order("name"),
  ]);
  const packageItems = ((items.data ?? []) as { id: string; name: string; package_sessions: number }[]).map((i) => ({
    id: i.id,
    name: i.name,
    sessions: i.package_sessions,
  }));

  return (
    <section>
      <h2 style={{ fontSize: 20, margin: "18px 0 4px" }}>Cuponeras</h2>
      <p style={{ color: "#5b6169", fontSize: 14, margin: "0 0 16px" }}>
        Saldo de sesiones por clienta. Al comprar una cuponera desde la web nace &ldquo;pendiente de pago&rdquo;;
        marcala pagada el día que abona. Cada reserva descuenta una sesión al reservar; cancelar una sesión
        futura la devuelve; un no-show ya está descontado. Los botones ±1 son para corregir a mano.
      </p>
      {"error" in packages ? (
        <ErrorBanner>No se pudieron cargar las cuponeras: {packages.error}</ErrorBanner>
      ) : (
        <PackagesPanel rows={packages.rows} packageItems={packageItems} />
      )}
      {items.error ? <ErrorBanner>No se pudieron cargar los ítems: {items.error.message}</ErrorBanner> : null}
    </section>
  );
}

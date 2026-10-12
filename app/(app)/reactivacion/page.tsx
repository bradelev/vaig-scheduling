/**
 * Reactivation view (PRD FR-4, issues E3-T4 + #53): clients with no upcoming
 * session whose last visit was more than 21 days ago, most recent first.
 * Each row offers a prefilled WhatsApp link and three contact-outcome
 * Server Actions (rebooked / declined / no reply) — the view itself hides
 * recently contacted clients, closing the loop. Fully server-rendered.
 */
import { createClient, hasSupabaseEnv } from "@/lib/supabase/server";
import { ErrorBanner } from "@/app/(app)/_components/Banners";
import {
  ReactivationList,
  type ReactivationRow,
} from "./ReactivationList";

export const dynamic = "force-dynamic";

export default async function ReactivacionPage() {
  if (!hasSupabaseEnv()) {
    return <p>La app no está configurada todavía.</p>;
  }

  const supabase = createClient();
  // Explicit order: the view has its own ORDER BY, but PostgREST does not
  // guarantee it survives the outer query — order at the query (AC 1).
  const { data, error } = await supabase
    .from("v_reactivation")
    .select("*")
    .order("days_since_last", { ascending: true })
    .limit(500);

  if (error) {
    return (
      <section style={{ paddingTop: 16 }}>
        <h2 style={{ fontSize: 20, margin: "0 0 12px" }}>Reactivación</h2>
        <ErrorBanner>No se pudo cargar la lista.</ErrorBanner>
      </section>
    );
  }

  const rows = (data ?? []) as ReactivationRow[];

  return (
    <section style={{ paddingTop: 16 }}>
      <h2 style={{ fontSize: 20, margin: "0 0 12px" }}>Reactivación</h2>
      {/* Live search + cards (issue #109): client component over
          server-rendered rows, same pattern as ClientTable (#70). */}
      <ReactivationList rows={rows} />
    </section>
  );
}

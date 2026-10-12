/**
 * Clientes grid (issue #128): a Google-Sheet-style editable table over the
 * client book, backed by v_client_status. Rows load server-side (the anon
 * key never reaches the browser); editing happens client-side via the
 * updateClient Server Action.
 */
import { createClient, hasSupabaseEnv } from "@/lib/supabase/server";
import { ErrorBanner } from "@/app/(app)/_components/Banners";
import ClientesGrid from "./ClientesGrid";

export const dynamic = "force-dynamic";

export type ClientRow = {
  id: string;
  full_name: string;
  phone: string;
  next_session_at: string | null;
  last_session_at: string | null;
  days_since_last: number | null;
  is_first_visit: boolean;
};

export default async function ClientesPage() {
  if (!hasSupabaseEnv()) {
    return <p>La app no está configurada todavía.</p>;
  }

  const supabase = createClient();
  const { data, error } = await supabase
    .from("v_client_status")
    .select(
      "id, full_name, phone, next_session_at, last_session_at, days_since_last, is_first_visit",
    )
    .order("full_name");

  if (error) {
    return (
      <section style={{ paddingTop: 16 }}>
        <h2 style={{ fontSize: 20, margin: "0 0 12px" }}>Clientes</h2>
        <ErrorBanner>
          No se pudieron cargar los clientes. Puede que la base todavía no
          esté migrada.
        </ErrorBanner>
      </section>
    );
  }

  const rows = (data ?? []) as ClientRow[];

  // The grid renders its own <h1>Clientes</h1> title.
  return <ClientesGrid rows={rows} />;
}

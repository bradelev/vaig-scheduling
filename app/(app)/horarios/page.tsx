/**
 * "Horarios" — the staff working-hours editor (Phase 1C.2 of the
 * online booking plan). Reception picks a staff member and edits their
 * availability rules (weekly recurring + one-off open days + blocks) that feed
 * the slot engine. Weekly rules are what keep availability from expiring once
 * the External per-date data runs out.
 *
 * Server-loads just the staff catalog; the rules for the chosen person are
 * fetched client-side on selection (same instant-load pattern as Nueva sesión).
 */
import { createClient, hasSupabaseEnv } from "@/lib/supabase/server";
import { fetchStaff, type Staff } from "@/lib/sessions/staff";
import Horarios from "./Horarios";

export const dynamic = "force-dynamic";

export type { Staff };

export default async function HorariosPage() {
  if (!hasSupabaseEnv()) {
    return (
      <main className="wrap">
        <p>Configuración pendiente.</p>
      </main>
    );
  }
  const db = createClient();
  const staff = await fetchStaff(db);
  return <Horarios staff={staff} />;
}

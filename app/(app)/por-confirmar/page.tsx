/**
 * "Reservas por confirmar" (Phase 2, the internal booking plan §"Reservas
 * por confirmar"): every public reservation still awaiting the team's
 * decision, grouped by day, with Confirmar / Reagendar / Cancelar per row.
 * Renders server-side with the staff session; the actions are server actions.
 */
import { createClient, hasSupabaseEnv } from "@/lib/supabase/server";
import { fetchPendingReservations } from "@/lib/sessions/pending";
import { groupPendingByDay } from "@/lib/sessions/pending-format";
import { fetchStaff } from "@/lib/sessions/staff";
import { ErrorBanner } from "@/app/(app)/_components/Banners";
import { PendingList } from "./PendingList";

export const dynamic = "force-dynamic";

export default async function PorConfirmarPage() {
  if (!hasSupabaseEnv()) {
    return <p>La app no está configurada todavía.</p>;
  }
  const nowMs = Date.now();
  const supabase = createClient();
  const [pending, staff] = await Promise.all([
    fetchPendingReservations(supabase, nowMs),
    fetchStaff(supabase),
  ]);

  const staffLabels: Record<string, string> = {};
  for (const s of staff) staffLabels[s.id] = s.label;

  return (
    <section>
      <h2 style={{ fontSize: 20, margin: "18px 0 4px" }}>Reservas web</h2>
      <p style={{ color: "#5b6169", fontSize: 14, margin: "0 0 16px" }}>
        Acá caen los turnos que las clientas reservan solas en la página web. El lugar ya queda
        bloqueado, pero nada es definitivo hasta que alguien del equipo lo <b>confirma</b>: recién
        ahí se agenda en el calendario y a la clienta le llega el WhatsApp de confirmación.
        Reagendar cambia la fecha pero la reserva sigue acá hasta confirmarla.
      </p>
      {"error" in pending ? (
        <ErrorBanner>No se pudieron cargar las reservas: {pending.error}</ErrorBanner>
      ) : (
        <PendingList groups={groupPendingByDay(pending.items, nowMs)} staffLabels={staffLabels} />
      )}
    </section>
  );
}

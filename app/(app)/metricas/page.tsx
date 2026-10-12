/**
 * Métricas (docs/booking-analytics.md): how the public booking page is used —
 * the funnel, unmet demand ("no quedan horarios"), looked-vs-booked per
 * service, OTP friction, busiest browsing hours, panel usage — plus the
 * "reservas a medio camino" recovery queue. Reads run as the staff cookie
 * session (RLS-gated); one RPC round trip for the aggregates.
 */
import { createClient, hasSupabaseEnv } from "@/lib/supabase/server";
import { ErrorBanner } from "@/app/(app)/_components/Banners";
import { BORDER_SOFT, INK, MUTED, SURFACE } from "@/lib/ui/theme";
import { MetricasView, type Metrics } from "./MetricasView";
import { RecoveryList, type RecoveryRow } from "./RecoveryList";

export const dynamic = "force-dynamic";

const RANGES = [7, 30, 90] as const;

function one<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export default async function MetricasPage({
  searchParams,
}: {
  searchParams: { dias?: string };
}) {
  if (!hasSupabaseEnv()) {
    return <p>La app no está configurada todavía.</p>;
  }
  const dias = RANGES.includes(Number(searchParams.dias) as (typeof RANGES)[number])
    ? Number(searchParams.dias)
    : 7;

  const db = createClient();
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const [metricsRes, recoveryRes] = await Promise.all([
    db.rpc("booking_metrics", { p_days: dias }),
    db
      .from("booking_recovery")
      .select("phone, slot_at, updated_at, contacted_at, clients(full_name), booking_services(name)")
      .gt("updated_at", cutoff)
      .order("updated_at", { ascending: false })
      .limit(50),
  ]);

  const recovery: RecoveryRow[] = (
    (recoveryRes.data ?? []) as {
      phone: string;
      slot_at: string | null;
      updated_at: string;
      contacted_at: string | null;
      clients: { full_name: string } | { full_name: string }[] | null;
      booking_services: { name: string } | { name: string }[] | null;
    }[]
  ).map((r) => ({
    phone: r.phone,
    slotAt: r.slot_at,
    updatedAt: r.updated_at,
    contactedAt: r.contacted_at,
    clientName: one(r.clients)?.full_name ?? null,
    serviceName: one(r.booking_services)?.name ?? null,
  }));

  return (
    <section>
      <h2 style={{ fontSize: 20, margin: "18px 0 4px" }}>Métricas</h2>
      <p style={{ color: MUTED, fontSize: 14, margin: "0 0 16px" }}>
        Cómo se usa la página de reservas y el panel. La rutina que rinde: una mirada semanal al
        embudo y a &ldquo;no quedan horarios&rdquo;, y actuar sobre esas dos.
      </p>

      <div style={{ display: "inline-flex", gap: 3, padding: 4, borderRadius: 10, background: "#ece7db", marginBottom: 18 }}>
        {RANGES.map((r) => (
          <a
            key={r}
            href={`/metricas?dias=${r}`}
            style={{
              padding: "8px 14px",
              borderRadius: 7,
              fontSize: 13.5,
              fontWeight: 600,
              textDecoration: "none",
              color: r === dias ? INK : MUTED,
              ...(r === dias ? { background: SURFACE, boxShadow: "0 1px 2px rgba(0,0,0,0.08)" } : {}),
            }}
          >
            Últimos {r} días
          </a>
        ))}
      </div>

      <div
        style={{
          border: `1px solid ${BORDER_SOFT}`,
          background: SURFACE,
          borderRadius: 12,
          padding: "16px 18px",
          marginBottom: 16,
        }}
      >
        <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>Reservas a medio camino</h3>
        <p style={{ color: MUTED, fontSize: 13, margin: "0 0 12px" }}>
          Verificaron su celular, eligieron servicio y horario, y no terminaron. Escribiles a mano,
          una por una, desde el WhatsApp del local — nada automático.
        </p>
        <RecoveryList rows={recovery} />
      </div>

      {metricsRes.error ? (
        <ErrorBanner>No se pudieron cargar las métricas: {metricsRes.error.message}</ErrorBanner>
      ) : (
        <MetricasView metrics={(metricsRes.data ?? {}) as Metrics} dias={dias} />
      )}
    </section>
  );
}

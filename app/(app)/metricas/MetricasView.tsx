/**
 * The aggregate blocks of Métricas: funnel, unmet demand, looked-vs-booked,
 * OTP friction, browsing hours, panel usage. Server component — everything
 * arrives pre-aggregated from the booking_metrics RPC; this only lays it out.
 * Each block carries its "cómo leerlo" line so conclusions are self-serve.
 */
import { ACCENT, BORDER_SOFT, INK, MUTED, SURFACE } from "@/lib/ui/theme";
import { weekLabel } from "@/lib/booking/public-flow";

export type Metrics = {
  funnel?: Record<string, number>;
  no_slots?: { name: string; week_key: string; times: number }[];
  per_service?: { name: string; viewed: number; booked: number }[];
  hours?: Record<string, number>;
  panel_usage?: Record<string, number>;
};

const FUNNEL_STEPS: { key: string; label: string }[] = [
  { key: "page_view", label: "Entraron" },
  { key: "service_selected", label: "Eligieron servicio" },
  { key: "slot_selected", label: "Eligieron horario" },
  { key: "code_verified", label: "Verificaron celular" },
  { key: "reserve_ok", label: "Reservaron" },
];

const PANEL_LABELS: Record<string, string> = {
  "/clientas": "Próximas sesiones",
  "/por-confirmar": "Reservas web",
  "/nueva-sesion": "Nueva sesión",
  "/cuponeras": "Cuponeras",
  "/clientes": "Clientes",
  "/sin-identificar": "Sin identificar",
  "/reactivacion": "Reactivación",
  "/resenas": "Reseñas",
  "/ajustes": "Ajustes",
  "/horarios": "Horarios",
  "/servicios": "Servicios",
  "/profesionales": "Profesionales",
  "/metricas": "Métricas",
};

const CARD: React.CSSProperties = {
  border: `1px solid ${BORDER_SOFT}`,
  background: SURFACE,
  borderRadius: 12,
  padding: "16px 18px",
  marginBottom: 16,
};
const COMO: React.CSSProperties = { color: MUTED, fontSize: 13, margin: "0 0 12px" };

function Bar({ label, n, max, color }: { label: string; n: number; max: number; color?: string }) {
  const width = max > 0 ? Math.max(2, Math.round((n / max) * 100)) : 2;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "150px 1fr 60px", gap: 10, alignItems: "center", margin: "6px 0", fontSize: 13.5 }}>
      <span style={{ textAlign: "right", fontWeight: 600, color: INK }}>{label}</span>
      <div style={{ height: 20, borderRadius: 6, background: color ?? ACCENT, width: `${width}%`, minWidth: 2 }} />
      <span style={{ color: MUTED, fontVariantNumeric: "tabular-nums" }}>{n}</span>
    </div>
  );
}

export function MetricasView({ metrics, dias }: { metrics: Metrics; dias: number }) {
  const funnel = metrics.funnel ?? {};
  const steps = FUNNEL_STEPS.map((s) => ({ ...s, n: funnel[s.key] ?? 0 }));
  const maxFunnel = Math.max(...steps.map((s) => s.n), 1);
  const entered = steps[0].n;
  const reserved = steps[steps.length - 1].n;
  const conversion = entered > 0 ? Math.round((reserved / entered) * 100) : null;

  const noSlots = metrics.no_slots ?? [];
  const perService = (metrics.per_service ?? []).filter((s) => s.viewed > 0);
  const requested = funnel["code_requested"] ?? 0;
  const verified = funnel["code_verified"] ?? 0;
  const hours = metrics.hours ?? {};
  const hourKeys = Array.from({ length: 24 }, (_, i) => i); // full local day
  const maxHour = Math.max(...hourKeys.map((h) => hours[String(h)] ?? 0), 1);
  const panel = Object.entries(metrics.panel_usage ?? {}).sort((a, b) => b[1] - a[1]);
  const maxPanel = Math.max(...panel.map(([, n]) => n), 1);

  return (
    <>
      <div style={CARD}>
        <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>El embudo</h3>
        <p style={COMO}>
          Personas distintas por paso, últimos {dias} días. La caída más grande entre dos barras es
          el problema número uno.
        </p>
        {steps.map((s, i) => (
          <Bar key={s.key} label={s.label} n={s.n} max={maxFunnel} color={i === steps.length - 1 ? "#1a7a1a" : undefined} />
        ))}
        <p style={{ fontSize: 13.5, margin: "10px 0 0", color: INK }}>
          {conversion === null ? (
            <span style={{ color: MUTED }}>Todavía sin visitas en el período.</span>
          ) : (
            <>
              Conversión: <b>{conversion}%</b> ({reserved} de {entered}).
            </>
          )}
        </p>
      </div>

      <div style={CARD}>
        <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>&ldquo;No quedan horarios&rdquo; — demanda sin atender</h3>
        <p style={COMO}>
          Gente que quiso un servicio y vio el calendario vacío. Es la lista de a qué cargarle
          horarios primero (Ajustes → Horarios).
        </p>
        {noSlots.length === 0 ? (
          <p style={{ fontSize: 13.5, color: MUTED, margin: 0 }}>Nadie se quedó sin horarios en el período ✓</p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13.5 }}>
            <thead>
              <tr>
                {["Servicio", "Veces", "Semana pedida"].map((h) => (
                  <th key={h} style={{ textAlign: "left", fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.05em", color: MUTED, padding: "4px 8px", borderBottom: `1px solid ${BORDER_SOFT}` }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {noSlots.map((r, i) => (
                <tr key={i}>
                  <td style={{ padding: "7px 8px", borderBottom: `1px solid ${BORDER_SOFT}` }}>{r.name}</td>
                  <td style={{ padding: "7px 8px", borderBottom: `1px solid ${BORDER_SOFT}`, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: r.times >= 10 ? "#a02525" : INK }}>{r.times}</td>
                  <td style={{ padding: "7px 8px", borderBottom: `1px solid ${BORDER_SOFT}`, fontVariantNumeric: "tabular-nums" }}>{r.week_key ? weekLabel(r.week_key) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={CARD}>
        <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>Se mira vs. se reserva</h3>
        <p style={COMO}>
          Un servicio muy mirado y poco reservado tiene algo: precio, sin profesionales asignadas o
          sin horarios.
        </p>
        {perService.length === 0 ? (
          <p style={{ fontSize: 13.5, color: MUTED, margin: 0 }}>Sin datos todavía.</p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13.5 }}>
            <thead>
              <tr>
                {["Servicio", "Lo miraron", "Reservaron", "%"].map((h) => (
                  <th key={h} style={{ textAlign: "left", fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.05em", color: MUTED, padding: "4px 8px", borderBottom: `1px solid ${BORDER_SOFT}` }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {perService.map((r, i) => {
                const pct = r.viewed > 0 ? Math.round((r.booked / r.viewed) * 100) : 0;
                return (
                  <tr key={i}>
                    <td style={{ padding: "7px 8px", borderBottom: `1px solid ${BORDER_SOFT}` }}>{r.name}</td>
                    <td style={{ padding: "7px 8px", borderBottom: `1px solid ${BORDER_SOFT}`, fontVariantNumeric: "tabular-nums" }}>{r.viewed}</td>
                    <td style={{ padding: "7px 8px", borderBottom: `1px solid ${BORDER_SOFT}`, fontVariantNumeric: "tabular-nums" }}>{r.booked}</td>
                    <td style={{ padding: "7px 8px", borderBottom: `1px solid ${BORDER_SOFT}`, fontWeight: 700, color: pct >= 40 ? "#1a7a1a" : pct >= 20 ? INK : "#a02525", fontVariantNumeric: "tabular-nums" }}>{pct}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div style={CARD}>
        <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>El código de WhatsApp</h3>
        <p style={COMO}>Si &ldquo;pidieron&rdquo; y &ldquo;verificaron&rdquo; se separan mucho, el código no llega o confunde.</p>
        <Bar label="Pidieron código" n={requested} max={Math.max(requested, 1)} />
        <Bar label="Verificaron" n={verified} max={Math.max(requested, 1)} />
        <p style={{ fontSize: 13.5, margin: "8px 0 0", color: MUTED }}>
          {requested === 0 ? "Sin pedidos en el período." : `${Math.round((verified / requested) * 100)}% verifica — por debajo de ~80% conviene investigar.`}
        </p>
      </div>

      <div style={CARD}>
        <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>A qué hora reserva la gente</h3>
        <p style={COMO}>Cuándo entran a la página (hora de Uruguay) — para saber cuándo conviene tener Reservas web al día.</p>
        <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 64 }}>
          {hourKeys.map((h) => {
            const n = hours[String(h)] ?? 0;
            return <div key={h} title={`${h}:00 — ${n}`} style={{ flex: 1, background: ACCENT, opacity: 0.85, borderRadius: "3px 3px 0 0", height: `${Math.max(3, Math.round((n / maxHour) * 100))}%` }} />;
          })}
        </div>
        <div style={{ display: "flex", gap: 3, fontSize: 10.5, color: MUTED, marginTop: 3 }}>
          {hourKeys.map((h) => (
            <span key={h} style={{ flex: 1, textAlign: "center" }}>{h}</span>
          ))}
        </div>
      </div>

      <div style={CARD}>
        <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>Qué usa el equipo del panel</h3>
        <p style={COMO}>
          Aperturas de cada pantalla, últimos {dias} días — para decidir con datos qué features valen
          la pena mantener.
        </p>
        {panel.length === 0 ? (
          <p style={{ fontSize: 13.5, color: MUTED, margin: 0 }}>Sin datos todavía (empieza a medir desde este deploy).</p>
        ) : (
          panel.map(([route, n]) => <Bar key={route} label={PANEL_LABELS[route] ?? route} n={n} max={maxPanel} />)
        )}
      </div>
    </>
  );
}

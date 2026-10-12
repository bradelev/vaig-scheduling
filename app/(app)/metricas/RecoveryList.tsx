"use client";

/**
 * The "reservas a medio camino" queue rows: who verified and stalled, what
 * they were about to book, a wa.me link with the message prefilled (HUMAN
 * send from the local's number — deliberately no automation), and a
 * contacted toggle. Rows self-expire after 14 days (endpoint sweep).
 */
import { useState, useTransition } from "react";
import { markRecoveryContacted } from "@/lib/recovery/actions";
import { Button } from "@/app/(app)/_components/Button";
import { BORDER_SOFT, INK, MUTED, WHATSAPP } from "@/lib/ui/theme";
import { summaryWhen } from "@/lib/booking/public-flow";

export type RecoveryRow = {
  phone: string;
  slotAt: string | null;
  updatedAt: string;
  contactedAt: string | null;
  clientName: string | null;
  serviceName: string | null;
};

function waLink(row: RecoveryRow): string {
  const service = row.serviceName ?? "tu sesión";
  const when = row.slotAt && Date.parse(row.slotAt) > Date.now() ? ` para el ${summaryWhen(row.slotAt)}` : "";
  const text = `¡Hola! Vimos que estuviste por reservar ${service}${when} y quedó a medio camino. ¿Te ayudamos a terminarla? 😊`;
  return `https://wa.me/${row.phone.replace(/^\+/, "")}?text=${encodeURIComponent(text)}`;
}

function ago(iso: string): string {
  const hours = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 3_600_000));
  if (hours < 1) return "hace minutos";
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  return `hace ${days} ${days === 1 ? "día" : "días"}`;
}

export function RecoveryList({ rows }: { rows: RecoveryRow[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, boolean>>({});

  if (rows.length === 0) {
    return <p style={{ fontSize: 13.5, color: MUTED, margin: 0 }}>Nada a medio camino ahora mismo ✓</p>;
  }

  function toggle(row: RecoveryRow) {
    const next = !(done[row.phone] ?? row.contactedAt !== null);
    setError(null);
    start(async () => {
      const res = await markRecoveryContacted({ phone: row.phone, contacted: next });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setDone((d) => ({ ...d, [row.phone]: next }));
    });
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {error ? (
        <div role="alert" style={{ fontSize: 13, color: "#a02525" }}>
          {error}
        </div>
      ) : null}
      {rows.map((row) => {
        const contacted = done[row.phone] ?? row.contactedAt !== null;
        return (
          <div
            key={row.phone}
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "6px 12px",
              alignItems: "center",
              border: `1px solid ${BORDER_SOFT}`,
              borderRadius: 10,
              padding: "10px 12px",
              opacity: contacted ? 0.6 : 1,
            }}
          >
            <div style={{ flex: "1 1 220px", minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: INK }}>
                {row.clientName ?? "Clienta nueva"}{" "}
                <span style={{ color: MUTED, fontWeight: 400, fontSize: 13 }}>{row.phone}</span>
              </div>
              <div style={{ color: MUTED, fontSize: 13 }}>
                {row.serviceName ?? "(sin servicio)"}
                {row.slotAt ? ` · miraba el ${summaryWhen(row.slotAt)}` : ""} · {ago(row.updatedAt)}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {contacted ? (
                <span style={{ fontSize: 13, fontWeight: 600, color: "#1a7a1a" }}>✓ Contactada</span>
              ) : (
                <a
                  href={waLink(row)}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    minHeight: 44,
                    padding: "0 14px",
                    borderRadius: 999,
                    background: WHATSAPP,
                    color: "#fff",
                    fontSize: 13.5,
                    fontWeight: 700,
                    textDecoration: "none",
                  }}
                >
                  Escribirle
                </a>
              )}
              <Button variant="quiet" size="sm" disabled={pending} onClick={() => toggle(row)}>
                {contacted ? "Desmarcar" : "Marcar contactada"}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

"use client";

/**
 * The pending-reservations list: day groups → rows with the slot, the client,
 * the item, the professional, and the three decisions. Confirmar is one tap;
 * Cancelar is two (same dangerGhost → danger pattern as the agenda's ⋮ menu);
 * Reagendar reuses the existing edit screen. A stale row (its time passed)
 * only offers Cancelar.
 */
import { useState, useTransition } from "react";
import { Button } from "@/app/(app)/_components/Button";
import { cancelReservation, confirmReservation } from "@/lib/sessions/actions";
import { type PendingDayGroup, type PendingReservation, timeRangeLabel } from "@/lib/sessions/pending-format";
import { BORDER_SOFT, MUTED } from "@/lib/ui/theme";

export function PendingList({
  groups,
  staffLabels,
}: {
  groups: PendingDayGroup[];
  staffLabels: Record<string, string>;
}) {
  if (groups.length === 0) {
    return (
      <p style={{ color: MUTED, fontSize: 14.5, padding: "24px 0" }}>
        No hay reservas pendientes. Las nuevas aparecen acá apenas la clienta reserva.
      </p>
    );
  }
  return (
    <div style={{ display: "grid", gap: 18 }}>
      {groups.map((g) => (
        <section
          key={g.dayKey}
          style={{ border: `1px solid ${BORDER_SOFT}`, borderRadius: 12, overflow: "visible" }}
        >
          <h3
            style={{
              fontSize: 14,
              fontWeight: 700,
              margin: 0,
              padding: "10px 14px",
              borderBottom: `1px solid ${BORDER_SOFT}`,
              textTransform: "capitalize",
            }}
          >
            {g.label}
          </h3>
          <div>
            {g.items.map((it, i) => (
              <PendingRow
                key={it.id}
                item={it}
                staffLabel={it.staffId ? staffLabels[it.staffId] ?? it.staffId : "Con quien sea"}
                last={i === g.items.length - 1}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function PendingRow({
  item,
  staffLabel,
  last,
}: {
  item: PendingReservation;
  staffLabel: string;
  last: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"confirmada" | "cancelada" | null>(null);
  const [pending, start] = useTransition();

  function run(action: () => Promise<{ ok: true } | { error: string } | { ok: true; mirrored: boolean }>, label: "confirmada" | "cancelada") {
    setError(null);
    start(async () => {
      const res = await action();
      if ("error" in res) {
        setError(res.error);
        setConfirming(false);
        return;
      }
      setDone(label);
      // The revalidate re-renders the list without this row.
    });
  }

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "8px 18px",
        alignItems: "center",
        padding: "12px 14px",
        borderBottom: last ? "none" : `1px solid ${BORDER_SOFT}`,
        opacity: item.stale && !done ? 0.75 : 1,
      }}
    >
      <div style={{ minWidth: 92, fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
        {timeRangeLabel(item.startsAt, item.endsAt)}
        {item.stale ? (
          <div style={{ fontSize: 11.5, fontWeight: 600, color: "#a02525" }}>Vencida</div>
        ) : null}
      </div>
      <div style={{ flex: "1 1 200px", minWidth: 0 }}>
        <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{item.clientName}</div>
        <div style={{ color: MUTED, fontSize: 12.5 }}>{item.clientPhone ?? "sin teléfono"}</div>
      </div>
      <div style={{ flex: "1 1 180px", minWidth: 0 }}>
        <div style={{ overflowWrap: "anywhere" }}>{item.serviceName}</div>
        <div style={{ color: MUTED, fontSize: 12.5 }}>{staffLabel}</div>
        {item.pkg ? (
          <div style={{ fontSize: 12, fontWeight: 600, color: item.pkg.unpaid ? "#8a5a12" : MUTED }}>
            Cuponera · {item.pkg.used} de {item.pkg.total}
            {item.pkg.unpaid ? " · sin pagar (cobrar al llegar)" : ""}
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {done ? (
          <span style={{ fontSize: 13, fontWeight: 600, color: done === "confirmada" ? "#1a7a1a" : "#555" }}>
            {done === "confirmada" ? "✓ Confirmada" : "Cancelada"}
          </span>
        ) : confirming ? (
          <>
            <span aria-live="polite" style={{ fontSize: 13, color: "#555" }}>¿Cancelar la reserva?</span>
            <Button
              variant="danger"
              size="sm"
              disabled={pending}
              onClick={() => run(() => cancelReservation({ sessionId: item.id }), "cancelada")}
            >
              {pending ? "Cancelando…" : "Sí, cancelar"}
            </Button>
            <Button variant="quiet" size="sm" disabled={pending} onClick={() => setConfirming(false)}>
              No
            </Button>
          </>
        ) : (
          <>
            {!item.stale ? (
              <Button
                variant="primary"
                size="sm"
                disabled={pending}
                onClick={() => run(() => confirmReservation({ sessionId: item.id }), "confirmada")}
              >
                {pending ? "Confirmando…" : "Confirmar"}
              </Button>
            ) : null}
            <Button variant="neutral" size="sm" href={`/nueva-sesion/${item.id}/editar`}>
              Reagendar
            </Button>
            <Button variant="dangerGhost" size="sm" disabled={pending} onClick={() => setConfirming(true)}>
              Cancelar
            </Button>
          </>
        )}
      </div>
      {error ? (
        <div role="alert" style={{ flexBasis: "100%", fontSize: 12.5, color: "#a02525" }}>{error}</div>
      ) : null}
    </div>
  );
}

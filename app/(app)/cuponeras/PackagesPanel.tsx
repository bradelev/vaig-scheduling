"use client";

/**
 * The Cuponeras panel body: a manual-load form (client search → item → totals)
 * and the list of open packages with their actions. Inline styles per the
 * app's convention; shared Button for the controls.
 */
import { useState, useTransition } from "react";
import { Button } from "@/app/(app)/_components/Button";
import { PACKAGE_STATUS_LABEL, packageRemaining } from "@/lib/booking/packages";
import {
  adjustPackageCredit,
  cancelPackage,
  createPackageManually,
  markPackagePaid,
  searchClients,
} from "@/lib/packages/actions";
import type { PackageRow } from "@/lib/packages/read";
import { BORDER_SOFT, INPUT_STYLE, LABEL_STYLE, MUTED } from "@/lib/ui/theme";

type PackageItem = { id: string; name: string; sessions: number };

export function PackagesPanel({ rows, packageItems }: { rows: PackageRow[]; packageItems: PackageItem[] }) {
  return (
    <div style={{ display: "grid", gap: 22 }}>
      <NewPackageForm packageItems={packageItems} />
      {rows.length === 0 ? (
        <p style={{ color: MUTED, fontSize: 14.5 }}>No hay cuponeras abiertas.</p>
      ) : (
        <div style={{ border: `1px solid ${BORDER_SOFT}`, borderRadius: 12 }}>
          {rows.map((r, i) => (
            <PackageRowView key={r.id} row={r} last={i === rows.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: PackageRow["status"] }) {
  const style =
    status === "pagada"
      ? { bg: "#e4f5e4", fg: "#1a7a1a" }
      : status === "pendiente_pago"
        ? { bg: "#fff3d6", fg: "#7a5200" }
        : { bg: "#f0f0f0", fg: "#555" };
  return (
    <span style={{ display: "inline-block", fontSize: 12, fontWeight: 600, borderRadius: 999, padding: "2px 10px", background: style.bg, color: style.fg }}>
      {PACKAGE_STATUS_LABEL[status]}
    </span>
  );
}

function PackageRowView({ row, last }: { row: PackageRow; last: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const remaining = packageRemaining(row);

  function run(action: () => Promise<{ ok: true } | { error: string }>) {
    setError(null);
    start(async () => {
      const res = await action();
      if ("error" in res) setError(res.error);
      setConfirmCancel(false);
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
      }}
    >
      <div style={{ flex: "1 1 200px", minWidth: 0 }}>
        <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{row.clientName}</div>
        <div style={{ color: MUTED, fontSize: 12.5 }}>{row.clientPhone ?? "sin teléfono"}</div>
      </div>
      <div style={{ flex: "1 1 200px", minWidth: 0 }}>
        <div style={{ overflowWrap: "anywhere" }}>{row.serviceName}</div>
        <div style={{ fontSize: 12.5, color: MUTED }}>
          <b style={{ color: remaining === 0 ? "#a02525" : "#1a1a1a" }}>{remaining}</b> de {row.total} sin usar · usadas {row.used}
        </div>
      </div>
      <div><StatusPill status={row.status} /></div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {row.status === "pendiente_pago" ? (
          <Button variant="primary" size="sm" disabled={pending} onClick={() => run(() => markPackagePaid({ packageId: row.id }))}>
            Marcar pagada
          </Button>
        ) : null}
        <Button variant="neutral" size="sm" disabled={pending || row.used >= row.total} title="Descontar una sesión (no-show)" onClick={() => run(() => adjustPackageCredit({ packageId: row.id, delta: 1 }))}>
          −1 sesión
        </Button>
        <Button variant="neutral" size="sm" disabled={pending || row.used === 0} title="Devolver una sesión" onClick={() => run(() => adjustPackageCredit({ packageId: row.id, delta: -1 }))}>
          +1 sesión
        </Button>
        {confirmCancel ? (
          <>
            <span style={{ fontSize: 13, color: "#555" }}>¿Cancelar la cuponera?</span>
            <Button variant="danger" size="sm" disabled={pending} onClick={() => run(() => cancelPackage({ packageId: row.id }))}>
              Sí, cancelar
            </Button>
            <Button variant="quiet" size="sm" disabled={pending} onClick={() => setConfirmCancel(false)}>No</Button>
          </>
        ) : (
          <Button variant="dangerGhost" size="sm" disabled={pending} onClick={() => setConfirmCancel(true)}>Cancelar</Button>
        )}
      </div>
      {error ? <div role="alert" style={{ flexBasis: "100%", fontSize: 12.5, color: "#a02525" }}>{error}</div> : null}
    </div>
  );
}

function NewPackageForm({ packageItems }: { packageItems: PackageItem[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [matches, setMatches] = useState<{ id: string; fullName: string; phone: string }[]>([]);
  const [client, setClient] = useState<{ id: string; fullName: string; phone: string } | null>(null);
  const [serviceId, setServiceId] = useState(packageItems[0]?.id ?? "");
  const [total, setTotal] = useState(packageItems[0]?.sessions ?? 6);
  const [used, setUsed] = useState(0);
  const [paid, setPaid] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  async function onSearch(value: string) {
    setQ(value);
    setClient(null);
    if (value.trim().length < 2) {
      setMatches([]);
      return;
    }
    const res = await searchClients({ q: value });
    if ("clients" in res) setMatches(res.clients);
  }

  function submit() {
    setError(null);
    if (!client) {
      setError("Elegí la clienta.");
      return;
    }
    start(async () => {
      const res = await createPackageManually({ clientId: client.id, serviceId, totalSessions: total, usedSessions: used, paid });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setDone(true);
      setQ("");
      setClient(null);
      setMatches([]);
      setUsed(0);
    });
  }

  if (!open) {
    return (
      <div>
        <Button variant="primary" onClick={() => { setOpen(true); setDone(false); }}>+ Cargar cuponera a mano</Button>
        {done ? <span style={{ marginLeft: 12, color: "#1a7a1a", fontWeight: 600, fontSize: 13.5 }}>✓ Cuponera creada</span> : null}
      </div>
    );
  }

  return (
    <div style={{ border: `1px solid ${BORDER_SOFT}`, borderRadius: 12, padding: 16, display: "grid", gap: 12, maxWidth: 520 }}>
      <div style={{ fontWeight: 700 }}>Cargar cuponera a mano</div>
      {packageItems.length === 0 ? (
        <p style={{ color: "#a02525", fontSize: 13.5, margin: 0 }}>
          Ningún ítem del catálogo tiene cantidad de sesiones cargada (<code>package_sessions</code>). Pedile a Braulio que la cargue.
        </p>
      ) : null}
      <div>
        <label style={LABEL_STYLE} htmlFor="pkg-client">Clienta (nombre o teléfono)</label>
        <input id="pkg-client" style={INPUT_STYLE} value={client ? `${client.fullName} · ${client.phone}` : q} onChange={(e) => void onSearch(e.target.value)} placeholder="Ana… / 099…" autoComplete="off" />
        {!client && matches.length > 0 ? (
          <div role="listbox" style={{ border: `1px solid ${BORDER_SOFT}`, borderRadius: 10, marginTop: 4, overflow: "hidden" }}>
            {matches.map((m) => (
              <Button key={m.id} variant="ghost" size="sm" block wrap role="option" onClick={() => { setClient(m); setMatches([]); }}>
                {m.fullName} · {m.phone}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <div>
        <label style={LABEL_STYLE} htmlFor="pkg-item">Cuponera</label>
        <select
          id="pkg-item"
          style={INPUT_STYLE}
          value={serviceId}
          onChange={(e) => {
            setServiceId(e.target.value);
            const it = packageItems.find((i) => i.id === e.target.value);
            if (it) setTotal(it.sessions);
          }}
        >
          {packageItems.map((i) => (
            <option key={i.id} value={i.id}>{i.name} ({i.sessions} sesiones)</option>
          ))}
        </select>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 120px" }}>
          <label style={LABEL_STYLE} htmlFor="pkg-total">Sesiones en total</label>
          <input id="pkg-total" type="number" inputMode="numeric" min={1} max={60} style={INPUT_STYLE} value={total} onChange={(e) => setTotal(Number(e.target.value))} />
        </div>
        <div style={{ flex: "1 1 120px" }}>
          <label style={LABEL_STYLE} htmlFor="pkg-used">Ya usadas</label>
          <input id="pkg-used" type="number" inputMode="numeric" min={0} max={total} style={INPUT_STYLE} value={used} onChange={(e) => setUsed(Number(e.target.value))} />
        </div>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
        <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Ya está pagada
      </label>
      {error ? <div role="alert" style={{ fontSize: 13, color: "#a02525" }}>{error}</div> : null}
      <div style={{ display: "flex", gap: 10 }}>
        <Button variant="primary" disabled={pending || packageItems.length === 0} onClick={submit}>{pending ? "Guardando…" : "Guardar"}</Button>
        <Button variant="quiet" disabled={pending} onClick={() => setOpen(false)}>Cerrar</Button>
      </div>
    </div>
  );
}

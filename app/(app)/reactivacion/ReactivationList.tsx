"use client";

/**
 * Reactivation grid (redesign, 2026-08-08): the old one-card-per-client layout
 * meant endless scrolling with ~100 clients to work through. This is a compact,
 * dense grid in the same hand-built style as ClientesGrid (#128): sticky
 * sortable header, zebra/hover rows, live search. Each row fits the whole
 * workflow inline — data + a WhatsApp button + the three contact outcomes —
 * so the receptionist works down the list without opening anything.
 *
 * The server renders the rows; filtering/sorting is client-side (same
 * matchesQuery semantics as the other screens, no anon key in the browser).
 * The outcome buttons stay Server Actions (markContactOutcome) — a client
 * component can host <form action>.
 */
import { useMemo, useState } from "react";
import { formatWhen, matchesQuery } from "@/lib/clients/status";
import {
  markContactOutcome,
  type ReactivationOutcome,
} from "@/lib/reactivation/actions";
import { DEFAULT_SIGNATURE, waLink } from "@/lib/reactivation/walink";
import { serviceLabel } from "@/lib/reactivation/service-label";
import { ACCENT, CONTROL_H, MUTED } from "@/lib/ui/theme";
import { Button, type ButtonVariant } from "@/app/(app)/_components/Button";
import styles from "@/app/(app)/_components/grid.module.css";

export type ReactivationRow = {
  id: string;
  full_name: string;
  phone: string;
  opted_out: boolean;
  last_reactivation_at: string | null;
  reactivation_outcome: string | null;
  last_session_at: string | null;
  last_service: string | null;
  days_since_last: number | null;
};

const COLS = "1.4fr 1fr 1fr 1fr 130px 150px";

const OUTCOME_LABELS: Record<ReactivationOutcome, string> = {
  rebooked: "reagendó",
  declined: "dijo que no",
  no_reply: "no contestó",
};

// The three inline outcome buttons: compact glyph + accessible label.
const OUTCOMES: {
  key: ReactivationOutcome;
  glyph: string;
  label: string;
}[] = [
  { key: "rebooked", glyph: "✓", label: "Reagendó" },
  { key: "declined", glyph: "✕", label: "Dijo que no" },
  { key: "no_reply", glyph: "—", label: "No contestó" },
];

// Outcome → Button variant, by whether it's the one already recorded for the
// row. Selected → solid (filled), so you can see AT A GLANCE which of ✓/✕/—
// is the recorded outcome; unselected → the quiet outlined form. (The date is
// still spelled out in the text line below.) Hoisted: stable across renders.
const OUTCOME_VARIANT: Record<
  "on" | "off",
  Record<ReactivationOutcome, ButtonVariant>
> = {
  on: { rebooked: "whatsapp", declined: "danger", no_reply: "muted" },
  off: { rebooked: "ghost", declined: "dangerGhost", no_reply: "quiet" },
};

type SortKey = "full_name" | "phone" | "days_since_last" | "service";
type SortDir = "asc" | "desc";

/** "12/08" in Montevideo — short date for the grid. */
function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat("es-UY", {
    timeZone: "America/Montevideo",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(iso));
}

function compareRows(a: ReactivationRow, b: ReactivationRow, key: SortKey): number {
  switch (key) {
    case "full_name":
      return a.full_name.localeCompare(b.full_name, "es");
    case "phone":
      return a.phone.localeCompare(b.phone);
    case "days_since_last": {
      const av = a.days_since_last;
      const bv = b.days_since_last;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av - bv;
    }
    case "service":
      return (serviceLabel(a.last_service) ?? "").localeCompare(
        serviceLabel(b.last_service) ?? "",
        "es",
      );
  }
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "full_name", label: "Nombre" },
  { key: "phone", label: "Teléfono" },
  { key: "days_since_last", label: "Última" },
  { key: "service", label: "Servicio" },
];

export function ReactivationList({ rows }: { rows: ReactivationRow[] }) {
  const [query, setQuery] = useState("");
  const [signature, setSignature] = useState(DEFAULT_SIGNATURE);
  const [isNew, setIsNew] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("days_since_last");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const visible = useMemo(() => {
    const filtered = rows.filter((r) => matchesQuery(r, query));
    const sorted = [...filtered].sort((a, b) => compareRows(a, b, sortKey));
    return sortDir === "desc" ? sorted.reverse() : sorted;
  }, [rows, query, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  return (
    <>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar por nombre o teléfono"
        aria-label="Buscar clienta por nombre o teléfono"
        style={{
          width: "100%",
          minHeight: CONTROL_H,
          fontSize: 16,
          padding: "0 12px",
          borderRadius: 8,
          border: "1px solid #ccc",
          boxSizing: "border-box",
          marginBottom: 10,
        }}
      />
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 10,
        }}
      >
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14, color: "#555" }}>
          Firma
          <input
            type="text"
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            aria-label="Firma para los mensajes"
            placeholder="Tu nombre"
            style={{
              width: "160px",
              minHeight: CONTROL_H,
              fontSize: 16,
              padding: "0 12px",
              borderRadius: 8,
              border: "1px solid #ccc",
              boxSizing: "border-box",
            }}
          />
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14, color: "#555", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={isNew}
            onChange={(e) => setIsNew(e.target.checked)}
          />
          Entré hace poco al equipo
        </label>
      </div>
      <p style={{ fontSize: 13, color: "#777", margin: "0 0 12px" }}>
        {visible.length} {visible.length === 1 ? "clienta" : "clientas"}
        {query.trim() === ""
          ? " sin próxima sesión hace más de 21 días. Las contactadas recientemente no aparecen hasta pasar la ventana de gracia."
          : ""}
      </p>

      {visible.length === 0 ? (
        <p style={{ color: "#777" }}>
          {rows.length === 0
            ? "No hay clientas para reactivar. 🎉"
            : "No hay clientas que coincidan."}
        </p>
      ) : (
        <div className={styles.frame}>
          {/* Header (desktop only; hidden in card mode) */}
          <div className={styles.headRow} style={{ ["--cols" as string]: COLS }}>
            {COLUMNS.map((c) => (
              <div
                key={c.key}
                role="columnheader"
                className={styles.th}
                onClick={() => toggleSort(c.key)}
              >
                {c.label}
                {sortKey === c.key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
              </div>
            ))}
            <div className={`${styles.th} ${styles.thStatic}`}>Contactar</div>
            <div className={`${styles.th} ${styles.thStatic}`}>Resultado</div>
          </div>

          {/* Rows (cards on mobile) */}
          {visible.map((row) => {
            const service = serviceLabel(row.last_service);
            const d = row.days_since_last;
            const rel = d === null ? "" : d === 0 ? "hoy" : d === 1 ? "hace 1 día" : `hace ${d} días`;
            const alreadyContacted = row.last_reactivation_at !== null;
            const outcomeKey =
              row.reactivation_outcome && row.reactivation_outcome in OUTCOME_LABELS
                ? (row.reactivation_outcome as ReactivationOutcome)
                : null;
            return (
              <div key={row.id} className={styles.row} style={{ ["--cols" as string]: COLS }}>
                <div className={`${styles.cell} ${styles.nameCell}`}>
                  <span className={styles.name}>{row.full_name}</span>
                </div>

                <div className={styles.cell}>
                  <span className={styles.cellLabel}>Teléfono</span>
                  <span>{row.phone}</span>
                </div>

                <div className={`${styles.cell} ${styles.cellStack}`}>
                  <span className={styles.cellLabel}>Última</span>
                  {row.last_session_at ? (
                    <span>
                      {formatShortDate(row.last_session_at)}
                      <span style={{ color: MUTED, fontSize: 12 }}> · {rel}</span>
                    </span>
                  ) : (
                    <span>—</span>
                  )}
                </div>

                <div className={styles.cell}>
                  <span className={styles.cellLabel}>Servicio</span>
                  <span>{service ?? "—"}</span>
                </div>

                <div className={`${styles.cell} ${styles.actionsCell}`}>
                  <span className={styles.cellLabel}>Contactar</span>
                  <Button
                    variant="whatsapp"
                    size="sm"
                    block
                    external
                    href={waLink(row.phone, row.full_name, {
                      signature,
                      isNew,
                      service: row.last_service,
                      lastSessionIso: row.last_session_at,
                    })}
                    aria-label={`Escribirle a ${row.full_name} por WhatsApp`}
                  >
                    💬 WhatsApp
                  </Button>
                </div>

                <div className={`${styles.cell} ${styles.actionsCell}`}>
                  <span className={styles.cellLabel}>Resultado</span>
                  <div style={{ display: "flex", gap: 4, width: "100%" }}>
                    {OUTCOMES.map((o) => {
                      const selected = outcomeKey === o.key;
                      return (
                        <form
                          key={o.key}
                          action={markContactOutcome.bind(null, row.id, o.key)}
                          style={{ flex: 1, display: "flex" }}
                        >
                          <Button
                            type="submit"
                            size="sm"
                            block
                            variant={
                              OUTCOME_VARIANT[selected ? "on" : "off"][o.key]
                            }
                            title={o.label}
                            aria-label={
                              selected ? `${o.label} (registrado)` : o.label
                            }
                          >
                            {o.glyph}
                          </Button>
                        </form>
                      );
                    })}
                  </div>
                  {alreadyContacted ? (
                    <span style={{ fontSize: 11, color: ACCENT, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 4 }}>
                      {outcomeKey
                        ? `${OUTCOME_LABELS[outcomeKey]} · ${formatWhen(row.last_reactivation_at)}`
                        : `contactada el ${formatWhen(row.last_reactivation_at)}`}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

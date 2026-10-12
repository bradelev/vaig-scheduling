"use client";

/**
 * Reviews board. Three tabs:
 *  - "Pendientes": loyal clients awaiting the automated review ask (candidates).
 *  - "Pedidas": history of clients already asked (not yet reviewed).
 *  - "Reseñaron" (2026-08-21): the record of who WAS marked as reviewed, so the
 *    "Ya reseñó" action doesn't just make them vanish.
 * Pendientes AND Pedidas both carry the "Ya reseñó" action (markReviewed) —
 * Google's API can't report who reviewed, and someone who reviewed on her own
 * must be removable BEFORE the automatic ask goes out, so staff mark it by
 * hand.
 * The ask itself is automated (send-review-requests); the health panel on top
 * shows what went out / is pending / the last batch outcome.
 *
 * Responsive via a CSS module (the one screen that isn't all-inline): a real
 * table on desktop, stacked cards on mobile.
 */
import { useMemo, useState } from "react";
import { formatWhen, matchesQuery } from "@/lib/clients/status";
import { serviceLabel } from "@/lib/reactivation/service-label";
import { markReviewed } from "@/lib/reviews/actions";
import type { ReviewBatchHealth } from "@/lib/reviews/health";
import { CONTROL_H } from "@/lib/ui/theme";
import { Button } from "@/app/(app)/_components/Button";
import styles from "@/app/(app)/_components/grid.module.css";

const COLS = "1.6fr 1fr 90px 1fr 1fr 130px";
const ASKED_COLS = "1.6fr 1fr 1fr 130px";
const REVIEWED_COLS = "1.6fr 1fr 1fr";

export type ReviewRow = {
  id: string;
  full_name: string;
  phone: string;
  completed_count: number;
  last_completed_at: string | null;
  last_completed_service: string | null;
  review_requested_at: string | null;
};

export type AskedRow = {
  id: string;
  full_name: string;
  phone: string;
  review_requested_at: string | null;
};

/** A client already marked as having left a review (the "Reseñaron" history). */
export type ReviewedRow = {
  id: string;
  full_name: string;
  phone: string;
  review_requested_at: string | null;
  reviewed_at: string | null;
};

type SortKey =
  | "full_name"
  | "phone"
  | "completed_count"
  | "last_completed_at"
  | "review_requested_at";
type SortDir = "asc" | "desc";

/** "12/08" in Montevideo — short date for the grid. */
function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat("es-UY", {
    timeZone: "America/Montevideo",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(iso));
}

/** Nulls-last comparator for optional ISO dates. */
function cmpNullableIso(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

function compareRows(a: ReviewRow, b: ReviewRow, key: SortKey): number {
  switch (key) {
    case "full_name":
      return a.full_name.localeCompare(b.full_name, "es");
    case "phone":
      return a.phone.localeCompare(b.phone);
    case "completed_count":
      return a.completed_count - b.completed_count;
    case "last_completed_at":
      return cmpNullableIso(a.last_completed_at, b.last_completed_at);
    case "review_requested_at":
      return cmpNullableIso(a.review_requested_at, b.review_requested_at);
  }
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "full_name", label: "Nombre" },
  { key: "phone", label: "Teléfono" },
  { key: "completed_count", label: "Sesiones" },
  { key: "last_completed_at", label: "Última" },
  { key: "review_requested_at", label: "Pedido" },
];

/**
 * Button to mark a client as reviewed with a two-step confirm pattern.
 * First click shows "¿Segura?" with Sí/No options, second click calls the action.
 */
function MarkReviewedButton({ clientId }: { clientId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleConfirm() {
    setBusy(true);
    setError("");
    try {
      await markReviewed(clientId);
      // No need to manually remove from list — revalidatePath will handle it
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Error al marcar como reseñado"
      );
      setBusy(false);
      // Keep `confirming` true so the error stays visible (it renders inside the
      // confirm block); the user can retry "Sí" or cancel with "No".
    }
  }

  if (confirming) {
    return (
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 14 }}>
        <Button
          variant="primary"
          size="sm"
          onClick={handleConfirm}
          disabled={busy}
        >
          {busy ? "Marcando…" : "Sí"}
        </Button>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => setConfirming(false)}
          disabled={busy}
        >
          No
        </Button>
        {error && (
          <div style={{ fontSize: 13, color: "#611a15", width: "100%" }}>
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
      ✓ Ya reseñó
    </Button>
  );
}

export function ReviewsList({
  rows,
  asked,
  reviewed,
  counts,
  batch,
}: {
  rows: ReviewRow[];
  asked: AskedRow[];
  reviewed: ReviewedRow[];
  counts: { pending: number; asked: number; reviewed: number };
  batch: ReviewBatchHealth;
}) {
  const [tab, setTab] = useState<"pendientes" | "pedidas" | "resenaron">(
    "pendientes",
  );
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("last_completed_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

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

  // Filter asked list by query
  const visibleAsked = useMemo(() => {
    return asked.filter((r) => matchesQuery(r, query));
  }, [asked, query]);

  // Filter reviewed list by query
  const visibleReviewed = useMemo(() => {
    return reviewed.filter((r) => matchesQuery(r, query));
  }, [reviewed, query]);

  return (
    <>
      {/* Health panel: the ask is automated, so staff can't see the pipeline
          by acting on it — this shows what went out, what's pending, and the
          last automated batch's outcome. */}
      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: 12,
          fontSize: 14,
        }}
      >
        <span
          style={{
            background: "#e7f6ec",
            color: "#0f5b2a",
            borderRadius: 999,
            padding: "4px 12px",
            fontWeight: 600,
          }}
        >
          {counts.asked} pedidas
        </span>
        <span
          style={{
            background: "#f0f2f5",
            color: "#4a5361",
            borderRadius: 999,
            padding: "4px 12px",
            fontWeight: 600,
          }}
        >
          {counts.pending} aún no
        </span>
        {batch.state === "errors" ? (
          <span
            style={{
              background: "#fdecea",
              color: "#611a15",
              borderRadius: 999,
              padding: "4px 12px",
              fontWeight: 600,
            }}
          >
            ⚠ {batch.errors} con error
          </span>
        ) : null}
        <span style={{ color: "#8a8f98", fontSize: 13 }}>
          {batch.state === "never"
            ? "· envío automático: sin corridas todavía"
            : `· último envío ${formatWhen(batch.finished_at)} · ${batch.sent} enviadas${
              batch.state === "errors" ? "" : " ✓"
            }`}
        </span>
      </div>

      {/* Tab toggle — segmented control (matches the Clientas filters). */}
      <div
        role="tablist"
        style={{
          display: "inline-flex",
          gap: 3,
          padding: 4,
          borderRadius: 11,
          background: "#efece6",
          marginBottom: 12,
        }}
      >
        {(
          [
            { key: "pendientes", label: `Pendientes · ${counts.pending}` },
            { key: "pedidas", label: `Pedidas · ${counts.asked}` },
            { key: "resenaron", label: `Reseñaron · ${counts.reviewed}` },
          ] as const
        ).map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              style={{
                border: "none",
                borderRadius: 8,
                minHeight: 44, // project tap-target rule
                padding: "0 14px",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                background: active ? "#fff" : "transparent",
                color: active ? "#1c222b" : "#5b6169",
                boxShadow: active ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "pendientes" && (
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
          <p style={{ fontSize: 13, color: "#777", margin: "0 0 12px" }}>
            {visible.length} {visible.length === 1 ? "clienta" : "clientas"}
            {query.trim() === ""
              ? " con 3 o más sesiones. El pedido de reseña se envía solo el día después de su próxima sesión."
              : ""}
          </p>

          {visible.length === 0 ? (
            <p style={{ color: "#777" }}>
              {rows.length === 0
                ? "No hay clientas fieles todavía. 🌸"
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
                <div role="columnheader" className={`${styles.th} ${styles.thStatic}`}>
                  Acción
                </div>
              </div>

              {/* Rows (cards on mobile) */}
              {visible.map((row) => {
                const service = serviceLabel(row.last_completed_service);
                return (
                  <div key={row.id} className={styles.row} style={{ ["--cols" as string]: COLS }}>
                    <div className={`${styles.cell} ${styles.nameCell}`}>
                      <span className={styles.name}>{row.full_name}</span>
                    </div>

                    <div className={styles.cell}>
                      <span className={styles.cellLabel}>Teléfono</span>
                      <span>{row.phone}</span>
                    </div>

                    <div className={styles.cell}>
                      <span className={styles.cellLabel}>Sesiones</span>
                      <span>{row.completed_count}</span>
                    </div>

                    <div className={`${styles.cell} ${styles.cellStack}`}>
                      <span className={styles.cellLabel}>Última</span>
                      {row.last_completed_at ? (
                        <span>
                          {formatShortDate(row.last_completed_at)}
                          {service ? (
                            <span className={styles.sub}> · {service}</span>
                          ) : null}
                        </span>
                      ) : (
                        <span>—</span>
                      )}
                    </div>

                    <div className={styles.cell}>
                      <span className={styles.cellLabel}>Pedido</span>
                      <span className={styles.muted}>
                        {row.review_requested_at
                          ? `enviado el ${formatWhen(row.review_requested_at)}`
                          : "aún no"}
                      </span>
                    </div>

                    <div className={`${styles.cell} ${styles.actionsCell}`}>
                      <span className={styles.cellLabel}>Acción</span>
                      <MarkReviewedButton clientId={row.id} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === "pedidas" && (
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
          <p style={{ fontSize: 13, color: "#777", margin: "0 0 12px" }}>
            {visibleAsked.length} {visibleAsked.length === 1 ? "clienta" : "clientas"}
          </p>

          {visibleAsked.length === 0 ? (
            <p style={{ color: "#777" }}>
              {asked.length === 0
                ? "Todavía no se le pidió reseña a nadie."
                : "Sin resultados"}
            </p>
          ) : (
            <div className={styles.frame}>
              {/* Header (desktop only; hidden in card mode) */}
              <div className={styles.headRow} style={{ ["--cols" as string]: ASKED_COLS }}>
                <div role="columnheader" className={styles.th}>
                  Nombre
                </div>
                <div role="columnheader" className={styles.th}>
                  Teléfono
                </div>
                <div role="columnheader" className={styles.th}>
                  Pedido
                </div>
                <div role="columnheader" className={styles.th} style={{ cursor: "default" }}>
                  Acción
                </div>
              </div>

              {/* Rows (cards on mobile) */}
              {visibleAsked.map((row) => (
                <div key={row.id} className={styles.row} style={{ ["--cols" as string]: ASKED_COLS }}>
                  <div className={`${styles.cell} ${styles.nameCell}`}>
                    <span className={styles.name}>{row.full_name}</span>
                  </div>

                  <div className={styles.cell}>
                    <span className={styles.cellLabel}>Teléfono</span>
                    <span>{row.phone}</span>
                  </div>

                  <div className={styles.cell}>
                    <span className={styles.cellLabel}>Pedido</span>
                    <span className={styles.muted}>
                      {row.review_requested_at
                        ? `el ${formatWhen(row.review_requested_at)}`
                        : "—"}
                    </span>
                  </div>

                  <div className={styles.cell}>
                    <span className={styles.cellLabel}>Acción</span>
                    <MarkReviewedButton clientId={row.id} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "resenaron" && (
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
          <p style={{ fontSize: 13, color: "#777", margin: "0 0 12px" }}>
            {visibleReviewed.length}{" "}
            {visibleReviewed.length === 1 ? "clienta reseñó" : "clientas reseñaron"}
          </p>

          {visibleReviewed.length === 0 ? (
            <p style={{ color: "#777" }}>
              {reviewed.length === 0
                ? "Todavía no marcaste a nadie como reseñada. Cuando una clienta deje su reseña, tildá “Ya reseñó” (en Pendientes o Pedidas) y va a aparecer acá."
                : "Sin resultados"}
            </p>
          ) : (
            <div className={styles.frame}>
              {/* Header (desktop only; hidden in card mode) */}
              <div className={styles.headRow} style={{ ["--cols" as string]: REVIEWED_COLS }}>
                <div role="columnheader" className={styles.th}>
                  Nombre
                </div>
                <div role="columnheader" className={styles.th}>
                  Teléfono
                </div>
                <div role="columnheader" className={styles.th}>
                  Estado
                </div>
              </div>

              {/* Rows (cards on mobile). No date: "reviewed" is a MANUAL mark
                  (staff tick "Ya reseñó" when they spot the review), so
                  reviewed_at is when it was ticked, not when the client
                  actually reviewed — showing it as a timestamp would mislead.
                  So just the settled ✓ state. */}
              {visibleReviewed.map((row) => (
                <div key={row.id} className={styles.row} style={{ ["--cols" as string]: REVIEWED_COLS }}>
                  <div className={`${styles.cell} ${styles.nameCell}`}>
                    <span className={styles.name}>{row.full_name}</span>
                  </div>

                  <div className={styles.cell}>
                    <span className={styles.cellLabel}>Teléfono</span>
                    <span>{row.phone}</span>
                  </div>

                  <div className={styles.cell}>
                    <span className={styles.cellLabel}>Estado</span>
                    <span style={{ color: "#1a7a3a", fontWeight: 600 }}>
                      ✓ Reseñó
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

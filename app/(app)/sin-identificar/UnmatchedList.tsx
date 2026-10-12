"use client";

/**
 * Filter chips over the unmatched queue (issue #95) — same client-side
 * pattern as the Clientas table (#70): the server already rendered every
 * row's data; chips only decide which subset shows. Three populations with
 * different work rhythms: "Con sugerencia" is the one-tap batch,
 * "Próximas" is the before-16:00 urgency list (soonest first), "Todas" is
 * the honest backlog.
 */
import { useState } from "react";
import {
  isUpcoming,
  titleMatchesQuery,
  type UnmatchedSession,
} from "@/lib/unmatched/resolve";
import { ACCENT, CONTROL_H } from "@/lib/ui/theme";
import type { ClientOption } from "./page";
import { UnmatchedRow } from "./UnmatchedRow";

export type QueueItem = {
  session: UnmatchedSession;
  candidates: ClientOption[];
  suggestedAlias: string[];
};

type Mode = "todas" | "proximas" | "sugeridas";

const EMPTY_BY_MODE: Record<Mode, string> = {
  todas: "No hay sesiones sin identificar. 🎉",
  proximas: "No hay sesiones próximas sin identificar. 🎉",
  sugeridas: "Ninguna pendiente tiene sugerencia — quedan las de tipear.",
};

export function UnmatchedList({
  items,
  clients,
  nowMs,
}: {
  items: QueueItem[];
  clients: ClientOption[];
  /** Server clock at render — keeps "próximas" identical on both sides. */
  nowMs: number;
}) {
  const [mode, setMode] = useState<Mode>("todas");
  const [query, setQuery] = useState("");

  // Search by the raw event title (issue #109), then the chip narrows —
  // search and chip compose, so counts reflect the searched set.
  const searched = items.filter((i) =>
    titleMatchesQuery(i.session.raw_title, query)
  );
  const proximas = searched.filter((i) => isUpcoming(i.session.starts_at, nowMs));
  const sugeridas = searched.filter((i) => i.candidates.length > 0);

  const chips: { mode: Mode; label: string }[] = [
    { mode: "todas", label: `Todas (${searched.length})` },
    { mode: "proximas", label: `Próximas (${proximas.length})` },
    { mode: "sugeridas", label: `Con sugerencia (${sugeridas.length})` },
  ];

  const visible = mode === "todas"
    ? searched
    : mode === "proximas"
    // Soonest first: this list is worked against the 16:00 deadline.
    ? [...proximas].sort((a, b) =>
      a.session.starts_at.localeCompare(b.session.starts_at)
    )
    : sugeridas;

  return (
    <>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar en la cola (ej: mica, piernas)"
        aria-label="Buscar sesiones sin identificar por el título del evento"
        style={{
          width: "100%",
          minHeight: CONTROL_H,
          fontSize: 16,
          padding: "0 12px",
          borderRadius: 8,
          border: "1px solid #ccc",
          boxSizing: "border-box",
          marginBottom: 12,
        }}
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        {chips.map((chip) => {
          const active = chip.mode === mode;
          return (
            <button
              key={chip.mode}
              type="button"
              onClick={() => setMode(chip.mode)}
              aria-pressed={active}
              style={{
                minHeight: 44,
                padding: "0 16px",
                borderRadius: 999,
                border: active ? `1px solid ${ACCENT}` : "1px solid #ccc",
                background: active ? ACCENT : "#fff",
                color: active ? "#fff" : "#111",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {visible.map((i) => (
          <UnmatchedRow
            key={i.session.id}
            session={i.session}
            candidates={i.candidates}
            clients={clients}
            suggestedAlias={i.suggestedAlias}
          />
        ))}
        {visible.length === 0 ? (
          <p style={{ color: "#777" }}>{EMPTY_BY_MODE[mode]}</p>
        ) : null}
      </div>
    </>
  );
}

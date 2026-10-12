"use client";

/**
 * Editable client book (issue #128) — a hand-built grid in plain React (no
 * data-grid dependency; the beta lib fought the app's styling and never looked
 * right). Google-Sheet feel with the app's own palette: sticky header, sortable
 * columns, filter (name/phone + first-visit), and click-to-edit cells that call
 * the updateClient Server Action. On error a cell reverts (field-scoped, so a
 * concurrent edit to another field is never clobbered) and shows the message.
 */
import { useMemo, useState } from "react";
import { createClient, deleteClient, updateClient } from "@/lib/clients/actions";
import { matchesQuery } from "@/lib/clients/status";
import { ErrorBanner } from "@/app/(app)/_components/Banners";
import { Button } from "@/app/(app)/_components/Button";
import {
  ACCENT,
  CONTROL_H,
  INK,
  INPUT_STYLE,
  MUTED,
} from "@/lib/ui/theme";
import styles from "@/app/(app)/_components/grid.module.css";
import type { ClientRow } from "./page";

const COLS = "1.6fr 1fr 1fr 100px 80px 40px";

type SortKey = "full_name" | "phone" | "days_since_last" | "next_session_at" | "is_first_visit";
type SortDir = "asc" | "desc";

/** "12/08" in Montevideo — short date for the grid. */
function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat("es-UY", {
    timeZone: "America/Montevideo",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(iso));
}

function compareRows(a: ClientRow, b: ClientRow, key: SortKey): number {
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
    case "next_session_at": {
      const av = a.next_session_at;
      const bv = b.next_session_at;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av.localeCompare(bv);
    }
    case "is_first_visit":
      return Number(a.is_first_visit) - Number(b.is_first_visit);
  }
}

function lastLabel(row: ClientRow): React.ReactNode {
  if (!row.last_session_at || row.days_since_last === null) return "—";
  const d = row.days_since_last;
  const rel = d === 0 ? "hoy" : d === 1 ? "hace 1 día" : `hace ${d} días`;
  return (
    <>
      {formatShortDate(row.last_session_at)}{" "}
      <span style={{ color: MUTED, fontSize: "0.85em" }}>({rel})</span>
    </>
  );
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "full_name", label: "Nombre" },
  { key: "phone", label: "Teléfono" },
  { key: "days_since_last", label: "Última" },
  { key: "next_session_at", label: "Próxima" },
  { key: "is_first_visit", label: "1ª vez" },
];

export default function ClientesGrid({ rows }: { rows: ClientRow[] }) {
  const [gridRows, setGridRows] = useState<ClientRow[]>(rows);
  const [query, setQuery] = useState("");
  const [onlyFirstVisit, setOnlyFirstVisit] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("full_name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; field: "full_name" | "phone" } | null>(null);
  const [draft, setDraft] = useState("");
  // Add-client inline form (curating the book — a client with no session yet).
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  // Per-row delete: which row is awaiting the 2nd confirm click, and busy state.
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const visible = useMemo(() => {
    const filtered = gridRows.filter(
      (r) => matchesQuery(r, query) && (!onlyFirstVisit || r.is_first_visit),
    );
    const sorted = [...filtered].sort((a, b) => compareRows(a, b, sortKey));
    return sortDir === "desc" ? sorted.reverse() : sorted;
  }, [gridRows, query, onlyFirstVisit, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function patchRow(id: string, patch: Partial<ClientRow>) {
    setGridRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function startEdit(row: ClientRow, field: "full_name" | "phone") {
    setError(null);
    setEditing({ id: row.id, field });
    setDraft(field === "full_name" ? row.full_name : row.phone);
  }

  async function commitEdit(row: ClientRow) {
    if (!editing) return;
    const field = editing.field;
    const value = draft.trim();
    setEditing(null);
    const current = field === "full_name" ? row.full_name : row.phone;
    if (value === current) return; // no change

    // optimistic
    patchRow(row.id, { [field]: value } as Partial<ClientRow>);
    const result = await updateClient(
      field === "full_name"
        ? { clientId: row.id, fullName: value }
        : { clientId: row.id, phone: value },
    );
    if ("error" in result) {
      setError(result.error);
      patchRow(row.id, { [field]: current } as Partial<ClientRow>); // revert this field only
    } else if (field === "phone" && result.phone) {
      patchRow(row.id, { phone: result.phone }); // server-normalized
    }
  }

  async function toggleFirstVisit(row: ClientRow, next: boolean) {
    setError(null);
    patchRow(row.id, { is_first_visit: next });
    const result = await updateClient({ clientId: row.id, isFirstVisit: next });
    if ("error" in result) {
      setError(result.error);
      patchRow(row.id, { is_first_visit: !next });
    }
  }

  /** From the view, "no sessions" ⇒ deletable in the UI. The server action
   * re-checks the sessions table authoritatively (incl. cancelled) before
   * deleting, so this is only which rows OFFER the delete, never the guard. */
  function hasNoSessions(row: ClientRow): boolean {
    return row.last_session_at === null && row.next_session_at === null;
  }

  async function handleAdd() {
    if (addBusy) return;
    setError(null);
    if (!newName.trim() || !newPhone.trim()) {
      setError("Falta el nombre o el teléfono.");
      return;
    }
    setAddBusy(true);
    const result = await createClient({ fullName: newName, phone: newPhone });
    setAddBusy(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    // Already in the book (same name + phone): don't render a phantom "new"
    // row — that would show null sessions (and a 🗑) over a client who may
    // have real history. Tell the operator and keep the form open.
    if (result.reused) {
      setError(
        `"${newName.trim()}" ya está en la lista con ese teléfono — buscala arriba.`,
      );
      return;
    }
    // Genuinely new — prepend so it's visible now (server also revalidates).
    setGridRows((cur) => [
      {
        id: result.clientId,
        full_name: newName.trim(),
        phone: newPhone.trim(),
        next_session_at: null,
        last_session_at: null,
        days_since_last: null,
        is_first_visit: false,
      },
      ...cur,
    ]);
    setNewName("");
    setNewPhone("");
    setAdding(false);
  }

  async function handleDelete(row: ClientRow) {
    if (deletingId) return;
    setError(null);
    setDeletingId(row.id);
    const result = await deleteClient({ clientId: row.id });
    setDeletingId(null);
    setConfirmingDelete(null);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setGridRows((cur) => cur.filter((r) => r.id !== row.id));
  }

  return (
    // Fills the app shell width (set in layout.tsx). The shell already provides
    // the horizontal padding, so only vertical padding here.
    <div style={{ padding: "20px 0 40px" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: INK, margin: "0 0 16px" }}>
        Clientes
      </h1>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar por nombre o teléfono"
        aria-label="Buscar por nombre o teléfono"
        style={{ ...INPUT_STYLE, marginBottom: 12 }}
      />

      <label
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          fontSize: 15,
          marginBottom: 12,
          cursor: "pointer",
          minHeight: 44,
        }}
      >
        <input
          type="checkbox"
          checked={onlyFirstVisit}
          onChange={(e) => setOnlyFirstVisit(e.target.checked)}
        />
        Solo primeras visitas
      </label>

      {/* Add a client to the book (no session needed). */}
      <div style={{ marginBottom: 12 }}>
        {adding ? (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
              padding: 12,
              border: `1px solid ${ACCENT}`,
              borderRadius: 10,
              background: "#f6f9ff",
            }}
          >
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nombre y apellido"
              aria-label="Nombre de la nueva clienta"
              style={{ ...INPUT_STYLE, flex: "1 1 180px", marginBottom: 0 }}
            />
            <input
              inputMode="tel"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              placeholder="Teléfono (+598…)"
              aria-label="Teléfono de la nueva clienta"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
                if (e.key === "Escape") setAdding(false);
              }}
              style={{ ...INPUT_STYLE, flex: "1 1 160px", marginBottom: 0 }}
            />
            <Button
              variant="primary"
              onClick={handleAdd}
              disabled={addBusy}
            >
              {addBusy ? "Agregando…" : "Agregar"}
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setAdding(false);
                setNewName("");
                setNewPhone("");
                setError(null);
              }}
              disabled={addBusy}
            >
              Cancelar
            </Button>
          </div>
        ) : (
          <Button variant="ghost" onClick={() => setAdding(true)}>
            + Nueva clienta
          </Button>
        )}
      </div>

      {error ? (
        <div style={{ marginBottom: 12 }}>
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      ) : null}

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
          {/* Actions column (delete) — no label. */}
          <div role="columnheader" className={styles.th} aria-label="Acciones" />
        </div>

        {/* Rows (cards on mobile) */}
        {visible.map((row) => {
          const isEditingName = editing?.id === row.id && editing.field === "full_name";
          const isEditingPhone = editing?.id === row.id && editing.field === "phone";
          return (
            <div key={row.id} className={styles.row} style={{ ["--cols" as string]: COLS }}>
              {/* Nombre */}
              <div
                className={`${styles.cell} ${styles.nameCell}`}
                style={{ cursor: "text" }}
                onClick={() => !editing && startEdit(row, "full_name")}
                title="Click para editar"
              >
                {isEditingName ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitEdit(row)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setEditing(null);
                    }}
                    style={editInputStyle}
                  />
                ) : (
                  <span className={styles.name}>{row.full_name}</span>
                )}
              </div>

              {/* Teléfono */}
              <div
                className={styles.cell}
                style={{ cursor: "text" }}
                onClick={() => !editing && startEdit(row, "phone")}
                title="Click para editar"
              >
                <span className={styles.cellLabel}>Teléfono</span>
                {isEditingPhone ? (
                  <input
                    autoFocus
                    inputMode="tel"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitEdit(row)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setEditing(null);
                    }}
                    style={editInputStyle}
                  />
                ) : (
                  <span>{row.phone}</span>
                )}
              </div>

              {/* Última */}
              <div className={styles.cell}>
                <span className={styles.cellLabel}>Última</span>
                {lastLabel(row)}
              </div>

              {/* Próxima */}
              <div className={styles.cell}>
                <span className={styles.cellLabel}>Próxima</span>
                <span>{row.next_session_at ? formatShortDate(row.next_session_at) : "—"}</span>
              </div>

              {/* 1ª vez */}
              <div className={styles.cell} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span className={styles.cellLabel}>1ª vez</span>
                <input
                  type="checkbox"
                  checked={row.is_first_visit}
                  onChange={(e) => toggleFirstVisit(row, e.target.checked)}
                  aria-label={`Primera vez: ${row.full_name}`}
                  style={{ width: 18, height: 18, cursor: "pointer" }}
                />
              </div>

              {/* Eliminar — only offered for clients with no sessions (data
                  curation). The server action re-checks authoritatively. */}
              <div
                className={styles.cell}
                style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}
              >
                <span className={styles.cellLabel}>Acciones</span>
                {hasNoSessions(row) ? (
                  confirmingDelete === row.id ? (
                    <>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleDelete(row)}
                        disabled={deletingId === row.id}
                        aria-label={`Confirmar eliminar a ${row.full_name}`}
                      >
                        {deletingId === row.id ? "Eliminando…" : "Eliminar"}
                      </Button>
                      <Button
                        variant="quiet"
                        size="sm"
                        onClick={() => setConfirmingDelete(null)}
                        disabled={deletingId === row.id}
                      >
                        No
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="dangerGhost"
                      size="sm"
                      onClick={() => {
                        setError(null);
                        setConfirmingDelete(row.id);
                      }}
                      aria-label={`Eliminar a ${row.full_name}`}
                    >
                      🗑
                    </Button>
                  )
                ) : null}
              </div>
            </div>
          );
        })}

        {visible.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: MUTED, fontSize: 15 }}>
            Sin resultados.
          </div>
        ) : null}
      </div>

      <p style={{ color: MUTED, fontSize: 13, marginTop: 10 }}>
        {visible.length} de {gridRows.length} · click en nombre o teléfono para editar
      </p>
    </div>
  );
}

const editInputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: CONTROL_H,
  fontSize: 15,
  padding: "0 8px",
  border: `2px solid ${ACCENT}`,
  borderRadius: 6,
  outline: "none",
  boxSizing: "border-box",
  color: "#1a1a1a" as const,
  background: "#fff",
};

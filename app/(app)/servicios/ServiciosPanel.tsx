"use client";

/**
 * The Servicios panel body: a search bar, a collapsible create form, and the
 * catalog grouped by category with inline edit / activate-deactivate.
 * Follows the PackagesPanel conventions (run/useTransition, two-step destructive
 * confirm) and the shared grid.module.css for the list rows.
 */
import { useId, useMemo, useState, useTransition } from "react";
import { Button } from "@/app/(app)/_components/Button";
import { createService, setServiceActive, updateService } from "@/lib/catalog/actions";
import { BORDER_SOFT, INK, INPUT_STYLE, LABEL_STYLE, MUTED } from "@/lib/ui/theme";
import styles from "@/app/(app)/_components/grid.module.css";
import type { ServiceRow } from "./page";

const COLS = "minmax(0,2.2fr) 0.8fr 0.9fr 0.9fr 1.4fr";
const WARN = "#8a5a12";
const ERROR_INK = "#a02525";

type ServiceDraftForm = {
  name: string;
  category: string;
  durationMin: string;
  priceUyu: string;
  packageSessions: string;
};

const EMPTY_DRAFT: ServiceDraftForm = {
  name: "",
  category: "",
  durationMin: "",
  priceUyu: "",
  packageSessions: "",
};

function draftFromRow(row: ServiceRow): ServiceDraftForm {
  return {
    name: row.name,
    category: row.category ?? "",
    durationMin: String(row.durationMin),
    priceUyu: row.priceUyu === null ? "" : String(row.priceUyu),
    packageSessions: row.packageSessions === null ? "" : String(row.packageSessions),
  };
}

function toActionDraft(form: ServiceDraftForm) {
  return {
    name: form.name,
    category: form.category,
    durationMin: form.durationMin,
    priceUyu: form.priceUyu,
    packageSessions: form.packageSessions,
  };
}

function formatPrice(priceUyu: number | null): string {
  if (priceUyu === null) return "a consultar";
  return `$ ${priceUyu.toLocaleString("es-UY")}`;
}

export function ServiciosPanel({ rows: initialRows }: { rows: ServiceRow[] }) {
  const [rows, setRows] = useState<ServiceRow[]>(initialRows);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const categories = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.category).filter((c): c is string => Boolean(c)))).sort((a, b) =>
        a.localeCompare(b, "es"),
      ),
    [rows],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.name.toLowerCase().includes(q) || (r.category ?? "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, ServiceRow[]>();
    for (const r of visible) {
      const key = r.category ?? "Sin categoría";
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
    const keys = Array.from(map.keys()).sort((a, b) => {
      if (a === "Sin categoría") return 1;
      if (b === "Sin categoría") return -1;
      return a.localeCompare(b, "es");
    });
    return keys.map((key) => ({ category: key, items: map.get(key) ?? [] }));
  }, [visible]);

  function upsertRow(row: ServiceRow) {
    setRows((cur) => {
      const idx = cur.findIndex((r) => r.id === row.id);
      if (idx === -1) return [...cur, row];
      const next = [...cur];
      next[idx] = row;
      return next;
    });
  }

  return (
    <div style={{ display: "grid", gap: 22 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por nombre o categoría"
          aria-label="Buscar por nombre o categoría"
          style={{ ...INPUT_STYLE, maxWidth: 320 }}
        />
        <Button variant="primary" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? "Cerrar" : "+ Nuevo servicio"}
        </Button>
      </div>

      {creating ? (
        <ServiceForm
          categories={categories}
          initial={EMPTY_DRAFT}
          submitLabel="Guardar"
          onCancel={() => setCreating(false)}
          onSubmit={async (form) => {
            const res = await createService(toActionDraft(form));
            if ("error" in res) return { error: res.error };
            upsertRow({
              id: res.id,
              name: form.name.trim(),
              category: form.category.trim() || null,
              durationMin: Number(form.durationMin),
              priceUyu: form.priceUyu === "" ? null : Number(form.priceUyu),
              packageSessions: form.packageSessions === "" ? null : Number(form.packageSessions),
              active: true,
              providerCount: 0,
            });
            setCreating(false);
            return { ok: true };
          }}
        />
      ) : null}

      {error ? (
        <div role="alert" style={{ fontSize: 13, color: ERROR_INK }}>
          {error}
        </div>
      ) : null}

      {grouped.length === 0 ? (
        <p style={{ color: MUTED, fontSize: 14.5 }}>No hay servicios que coincidan con la búsqueda.</p>
      ) : (
        grouped.map((group) => (
          <div key={group.category}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: INK, margin: "0 0 8px" }}>{group.category}</h3>
            <div className={styles.frame}>
              <div className={styles.headRow} style={{ ["--cols" as string]: COLS }}>
                <div className={styles.th}>Nombre</div>
                <div className={styles.th}>Duración</div>
                <div className={styles.th}>Precio</div>
                <div className={styles.th}>Profesionales</div>
                <div className={styles.th}>Acciones</div>
              </div>
              {group.items.map((row) => (
                <ServiceRowView
                  key={row.id}
                  row={row}
                  categories={categories}
                  onUpdated={upsertRow}
                  onError={setError}
                />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function ServiceRowView({
  row,
  categories,
  onUpdated,
  onError,
}: {
  row: ServiceRow;
  categories: string[];
  onUpdated: (row: ServiceRow) => void;
  onError: (msg: string | null) => void;
}) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  function run(action: () => Promise<{ ok: true } | { error: string }>, after?: () => void) {
    onError(null);
    start(async () => {
      const res = await action();
      if ("error" in res) {
        onError(res.error);
      } else {
        after?.();
      }
      setConfirmDeactivate(false);
    });
  }

  function toggleActive() {
    run(
      () => setServiceActive({ id: row.id, active: !row.active }),
      () => onUpdated({ ...row, active: !row.active }),
    );
  }

  return (
    <>
      <div className={styles.row} style={{ ["--cols" as string]: COLS, opacity: row.active ? 1 : 0.55 }}>
        <div className={`${styles.cell} ${styles.nameCell}`} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, minHeight: 52, justifyContent: "center" }}>
          <span className={styles.name}>{row.name}</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {row.packageSessions ? (
              <span style={{ fontSize: 12, color: MUTED }}>Cuponera · {row.packageSessions} sesiones</span>
            ) : null}
            {!row.active ? <span style={{ fontSize: 12, color: MUTED }}>Inactivo</span> : null}
          </div>
        </div>
        <div className={styles.cell}>
          <span className={styles.cellLabel}>Duración</span>
          <span>{row.durationMin} min</span>
        </div>
        <div className={styles.cell}>
          <span className={styles.cellLabel}>Precio</span>
          <span>{formatPrice(row.priceUyu)}</span>
        </div>
        <div className={styles.cell}>
          <span className={styles.cellLabel}>Profesionales</span>
          {row.providerCount === 0 && row.active ? (
            <span style={{ color: WARN }} title="Sin profesionales asignadas — no aparece ningún horario">
              {row.providerCount} prof.
            </span>
          ) : (
            <span>{row.providerCount} prof.</span>
          )}
        </div>
        <div className={`${styles.cell} ${styles.actionsCell}`} style={{ gap: 8, flexWrap: "wrap" }}>
          <span className={styles.cellLabel}>Acciones</span>
          <Button variant="quiet" size="sm" disabled={pending} onClick={() => setEditing((v) => !v)}>
            {editing ? "Cancelar" : "Editar"}
          </Button>
          {confirmDeactivate ? (
            <>
              <span style={{ fontSize: 13, color: "#555" }}>¿Seguro?</span>
              <Button variant="danger" size="sm" disabled={pending} onClick={toggleActive}>
                Sí, desactivar
              </Button>
              <Button variant="quiet" size="sm" disabled={pending} onClick={() => setConfirmDeactivate(false)}>
                No
              </Button>
            </>
          ) : row.active ? (
            <Button variant="dangerGhost" size="sm" disabled={pending} onClick={() => setConfirmDeactivate(true)}>
              Desactivar
            </Button>
          ) : (
            <Button variant="neutral" size="sm" disabled={pending} onClick={toggleActive}>
              Activar
            </Button>
          )}
        </div>
      </div>
      {editing ? (
        <div style={{ padding: "0 14px 16px", borderBottom: `1px solid ${BORDER_SOFT}` }}>
          <ServiceForm
            categories={categories}
            initial={draftFromRow(row)}
            submitLabel="Guardar"
            onCancel={() => setEditing(false)}
            onSubmit={async (form) => {
              const res = await updateService({ id: row.id, draft: toActionDraft(form) });
              if ("error" in res) return { error: res.error };
              onUpdated({
                ...row,
                name: form.name.trim(),
                category: form.category.trim() || null,
                durationMin: Number(form.durationMin),
                priceUyu: form.priceUyu === "" ? null : Number(form.priceUyu),
                packageSessions: form.packageSessions === "" ? null : Number(form.packageSessions),
              });
              setEditing(false);
              return { ok: true };
            }}
          />
        </div>
      ) : null}
    </>
  );
}

function ServiceForm({
  categories,
  initial,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  categories: string[];
  initial: ServiceDraftForm;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (form: ServiceDraftForm) => Promise<{ ok: true } | { error: string }>;
}) {
  const [form, setForm] = useState<ServiceDraftForm>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // The create form and any open edit form render together: ids must be unique
  // per instance or labels/datalists cross-wire.
  const uid = useId();

  function submit() {
    setError(null);
    start(async () => {
      const res = await onSubmit(form);
      if ("error" in res) setError(res.error);
    });
  }

  return (
    <div style={{ border: `1px solid ${BORDER_SOFT}`, borderRadius: 12, padding: 16, display: "grid", gap: 12, maxWidth: 560 }}>
      <div>
        <label style={LABEL_STYLE} htmlFor={`${uid}-name`}>Nombre</label>
        <input
          id={`${uid}-name`}
          style={INPUT_STYLE}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </div>
      <div>
        <label style={LABEL_STYLE} htmlFor={`${uid}-category`}>Categoría</label>
        <input
          id={`${uid}-category`}
          list={`${uid}-categories`}
          style={INPUT_STYLE}
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
        />
        <datalist id={`${uid}-categories`}>
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 140px" }}>
          <label style={LABEL_STYLE} htmlFor={`${uid}-duration`}>Duración (min)</label>
          <input
            id={`${uid}-duration`}
            type="number"
            inputMode="numeric"
            min={5}
            max={480}
            style={INPUT_STYLE}
            value={form.durationMin}
            onChange={(e) => setForm({ ...form, durationMin: e.target.value })}
          />
        </div>
        <div style={{ flex: "1 1 140px" }}>
          <label style={LABEL_STYLE} htmlFor={`${uid}-price`}>Precio ($)</label>
          <input
            id={`${uid}-price`}
            type="number"
            inputMode="numeric"
            min={0}
            placeholder="a consultar"
            style={INPUT_STYLE}
            value={form.priceUyu}
            onChange={(e) => setForm({ ...form, priceUyu: e.target.value })}
          />
        </div>
      </div>
      <div>
        <label style={LABEL_STYLE} htmlFor={`${uid}-sessions`}>Sesiones de cuponera</label>
        <input
          id={`${uid}-sessions`}
          type="number"
          inputMode="numeric"
          min={2}
          max={60}
          placeholder="servicio normal"
          style={INPUT_STYLE}
          value={form.packageSessions}
          onChange={(e) => setForm({ ...form, packageSessions: e.target.value })}
        />
        <p style={{ color: MUTED, fontSize: 12.5, margin: "4px 0 0" }}>
          Dejalo vacío si es un servicio normal (no una cuponera).
        </p>
      </div>
      {error ? (
        <div role="alert" style={{ fontSize: 13, color: ERROR_INK }}>
          {error}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 10 }}>
        <Button variant="primary" size="sm" disabled={pending} onClick={submit}>
          {pending ? "Guardando…" : submitLabel}
        </Button>
        <Button variant="quiet" size="sm" disabled={pending} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

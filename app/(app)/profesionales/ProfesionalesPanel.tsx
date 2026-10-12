"use client";

/**
 * The Profesionales panel body: a collapsible create form and a card per
 * professional with inline edit, activate/deactivate, and a "which services
 * she gives" checklist. Follows the PackagesPanel conventions
 * (run/useTransition, two-step destructive confirm).
 */
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/app/(app)/_components/Button";
import {
  createStaffMember,
  setStaffActive,
  setStaffPriority,
  setStaffServices,
  updateStaffMember,
} from "@/lib/staff/actions";
import { CALENDAR_COLORS } from "@/lib/staff/validate";
import { ACCENT, BORDER_SOFT, INK, INPUT_STYLE, LABEL_STYLE, MUTED, OK_INK } from "@/lib/ui/theme";
import type { CatalogServiceOption, ProfessionalRow } from "./page";

const ERROR_INK = "#a02525";

type StaffDraftForm = { name: string; phone: string; colorId: string };
const EMPTY_DRAFT: StaffDraftForm = { name: "", phone: "", colorId: "" };

function colorHex(colorId: number | null): string {
  return CALENDAR_COLORS.find((c) => c.id === colorId)?.hex ?? "#c8ccd2";
}

function ColorSwatch({ colorId, size = 14 }: { colorId: number | null; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: colorHex(colorId),
        border: "1px solid rgba(0,0,0,0.1)",
        flexShrink: 0,
      }}
    />
  );
}

export function ProfesionalesPanel({
  rows: initialRows,
  serviceOptions,
}: {
  rows: ProfessionalRow[];
  serviceOptions: CatalogServiceOption[];
}) {
  const [rows, setRows] = useState<ProfessionalRow[]>(initialRows);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState(false);

  function upsertRow(row: ProfessionalRow) {
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
      <div>
        <Button variant="primary" size="sm" onClick={() => { setCreating((v) => !v); setJustCreated(false); }}>
          {creating ? "Cerrar" : "+ Nueva profesional"}
        </Button>
        {justCreated ? (
          <p style={{ color: OK_INK, fontSize: 13.5, marginTop: 8 }}>
            Creada. Cargale horarios en{" "}
            <Link href="/horarios" style={{ color: OK_INK, textDecoration: "underline" }}>
              Horarios
            </Link>{" "}
            y marcá qué servicios da.
          </p>
        ) : null}
      </div>

      {creating ? (
        <StaffCreateForm
          onCancel={() => setCreating(false)}
          onCreated={(row) => {
            upsertRow(row);
            setCreating(false);
            setJustCreated(true);
          }}
        />
      ) : null}

      {error ? (
        <div role="alert" style={{ fontSize: 13, color: ERROR_INK }}>
          {error}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p style={{ color: MUTED, fontSize: 14.5 }}>No hay profesionales cargadas.</p>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {rows.map((row) => (
            <ProfessionalCard
              key={row.id}
              row={row}
              serviceOptions={serviceOptions}
              onUpdated={upsertRow}
              onError={setError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StaffCreateForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (row: ProfessionalRow) => void;
}) {
  const [form, setForm] = useState<StaffDraftForm>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      const res = await createStaffMember({
        name: form.name,
        phone: form.phone,
        colorId: form.colorId,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      onCreated({
        id: res.id,
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        colorId: form.colorId === "" ? null : Number(form.colorId),
        active: true,
        serviceIds: [],
        priority: null,
      });
    });
  }

  return (
    <div style={{ border: `1px solid ${BORDER_SOFT}`, borderRadius: 12, padding: 16, display: "grid", gap: 12, maxWidth: 520 }}>
      <div style={{ fontWeight: 700 }}>Nueva profesional</div>
      <div>
        <label style={LABEL_STYLE} htmlFor="staff-name">Nombre</label>
        <input
          id="staff-name"
          style={INPUT_STYLE}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </div>
      <div>
        <label style={LABEL_STYLE} htmlFor="staff-phone">WhatsApp</label>
        <input
          id="staff-phone"
          inputMode="tel"
          placeholder="+598 99 123 456"
          style={INPUT_STYLE}
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
        <p style={{ color: MUTED, fontSize: 12.5, margin: "4px 0 0" }}>para avisarle cuando le entra una reserva</p>
      </div>
      <div>
        <label style={LABEL_STYLE} htmlFor="staff-color">Color de calendario</label>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <ColorSwatch colorId={form.colorId === "" ? null : Number(form.colorId)} />
          <select
            id="staff-color"
            style={INPUT_STYLE}
            value={form.colorId}
            onChange={(e) => setForm({ ...form, colorId: e.target.value })}
          >
            <option value="">Sin color</option>
            {CALENDAR_COLORS.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>
      </div>
      {error ? (
        <div role="alert" style={{ fontSize: 13, color: ERROR_INK }}>
          {error}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 10 }}>
        <Button variant="primary" size="sm" disabled={pending} onClick={submit}>
          {pending ? "Guardando…" : "Guardar"}
        </Button>
        <Button variant="quiet" size="sm" disabled={pending} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

function ProfessionalCard({
  row,
  serviceOptions,
  onUpdated,
  onError,
}: {
  row: ProfessionalRow;
  serviceOptions: CatalogServiceOption[];
  onUpdated: (row: ProfessionalRow) => void;
  onError: (msg: string | null) => void;
}) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(false);

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
      () => setStaffActive({ id: row.id, active: !row.active }),
      () => onUpdated({ ...row, active: !row.active }),
    );
  }

  return (
    <div style={{ border: `1px solid ${BORDER_SOFT}`, borderRadius: 12, padding: 14, opacity: row.active ? 1 : 0.55 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <ColorSwatch colorId={row.colorId} />
        <span style={{ fontWeight: 700, color: INK }}>{row.name}</span>
        <span style={{ color: MUTED, fontSize: 12.5 }}>({row.id})</span>
        {!row.active ? <span style={{ color: MUTED, fontSize: 12 }}>Inactiva</span> : null}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
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
      <div style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>
        {row.phone ?? "sin WhatsApp"} · {row.serviceIds.length} servicios ·{" "}
        <span title="Menor número = la eligen primero en 'con quien sea'">
          {row.priority === null ? "sin prioridad" : `prioridad ${row.priority}`}
        </span>
      </div>

      {editing ? (
        <div style={{ marginTop: 12 }}>
          <EditForm
            row={row}
            onCancel={() => setEditing(false)}
            onSaved={(updated) => {
              onUpdated(updated);
              setEditing(false);
            }}
            onError={onError}
          />
        </div>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <Button variant="quiet" size="sm" onClick={() => setServicesOpen((v) => !v)}>
          Servicios ({row.serviceIds.length}) {servicesOpen ? "▴" : "▾"}
        </Button>
        {servicesOpen ? (
          <ServicesChecklist
            row={row}
            serviceOptions={serviceOptions}
            onSaved={(serviceIds) =>
              onUpdated({
                ...row,
                serviceIds,
                // New links are created at the existing priority, or 100 when
                // she had none — mirror that so the card doesn't keep claiming
                // "sin prioridad" for links that now exist at 100.
                priority: row.priority ?? (serviceIds.length > 0 ? 100 : null),
              })
            }
            onError={onError}
            onClose={() => setServicesOpen(false)}
          />
        ) : null}
      </div>
    </div>
  );
}

function EditForm({
  row,
  onCancel,
  onSaved,
  onError,
}: {
  row: ProfessionalRow;
  onCancel: () => void;
  onSaved: (row: ProfessionalRow) => void;
  onError: (msg: string | null) => void;
}) {
  const [form, setForm] = useState<StaffDraftForm>({
    name: row.name,
    phone: row.phone ?? "",
    colorId: row.colorId === null ? "" : String(row.colorId),
  });
  const [priority, setPriority] = useState(row.priority === null ? "" : String(row.priority));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      const res = await updateStaffMember({
        id: row.id,
        draft: { name: form.name, phone: form.phone, colorId: form.colorId },
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      let nextPriority = row.priority;
      const priorityChanged = priority !== (row.priority === null ? "" : String(row.priority));
      if (priorityChanged && priority !== "") {
        const priorityRes = await setStaffPriority({ id: row.id, priority });
        if ("error" in priorityRes) {
          setError(priorityRes.error);
          return;
        }
        nextPriority = Number(priority);
      }
      onSaved({
        ...row,
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        colorId: form.colorId === "" ? null : Number(form.colorId),
        priority: nextPriority,
      });
    });
  }

  return (
    <div style={{ border: `1px solid ${BORDER_SOFT}`, borderRadius: 12, padding: 16, display: "grid", gap: 12, maxWidth: 520 }}>
      <div>
        <label style={LABEL_STYLE} htmlFor={`staff-edit-name-${row.id}`}>Nombre</label>
        <input
          id={`staff-edit-name-${row.id}`}
          style={INPUT_STYLE}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </div>
      <div>
        <label style={LABEL_STYLE} htmlFor={`staff-edit-phone-${row.id}`}>WhatsApp</label>
        <input
          id={`staff-edit-phone-${row.id}`}
          inputMode="tel"
          placeholder="+598 99 123 456"
          style={INPUT_STYLE}
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
      </div>
      <div>
        <label style={LABEL_STYLE} htmlFor={`staff-edit-color-${row.id}`}>Color de calendario</label>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <ColorSwatch colorId={form.colorId === "" ? null : Number(form.colorId)} />
          <select
            id={`staff-edit-color-${row.id}`}
            style={INPUT_STYLE}
            value={form.colorId}
            onChange={(e) => setForm({ ...form, colorId: e.target.value })}
          >
            <option value="">Sin color</option>
            {CALENDAR_COLORS.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label style={LABEL_STYLE} htmlFor={`staff-edit-priority-${row.id}`}>Prioridad</label>
        <input
          id={`staff-edit-priority-${row.id}`}
          type="number"
          inputMode="numeric"
          min={1}
          max={999}
          style={INPUT_STYLE}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        />
        <p style={{ color: MUTED, fontSize: 12.5, margin: "4px 0 0" }}>
          Menor = la eligen primero en &ldquo;con quien sea&rdquo;. Se aplica a todos sus servicios.
        </p>
      </div>
      {error ? (
        <div role="alert" style={{ fontSize: 13, color: ERROR_INK }}>
          {error}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 10 }}>
        <Button variant="primary" size="sm" disabled={pending} onClick={submit}>
          {pending ? "Guardando…" : "Guardar"}
        </Button>
        <Button variant="quiet" size="sm" disabled={pending} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

function ServicesChecklist({
  row,
  serviceOptions,
  onSaved,
  onError,
  onClose,
}: {
  row: ProfessionalRow;
  serviceOptions: CatalogServiceOption[];
  onSaved: (serviceIds: string[]) => void;
  onError: (msg: string | null) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(row.serviceIds));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, CatalogServiceOption[]>();
    for (const s of serviceOptions) {
      const key = s.category ?? "Sin categoría";
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    return Array.from(map.entries()).map(([category, items]) => ({ category, items }));
  }, [serviceOptions]);

  const initial = useMemo(() => new Set(row.serviceIds), [row.serviceIds]);
  const unchanged =
    selected.size === initial.size && Array.from(selected).every((id) => initial.has(id));

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setAllInCategory(items: CatalogServiceOption[], value: boolean) {
    setSelected((cur) => {
      const next = new Set(cur);
      for (const item of items) {
        if (value) next.add(item.id);
        else next.delete(item.id);
      }
      return next;
    });
  }

  function submit() {
    setError(null);
    start(async () => {
      const res = await setStaffServices({ id: row.id, serviceIds: Array.from(selected) });
      if ("error" in res) {
        setError(res.error);
        onError(res.error);
        return;
      }
      onSaved(Array.from(selected));
    });
  }

  function cancel() {
    setSelected(new Set<string>(row.serviceIds));
    onClose();
  }

  return (
    <div style={{ border: `1px solid ${BORDER_SOFT}`, borderRadius: 12, padding: 16, marginTop: 10, display: "grid", gap: 14 }}>
      {grouped.map((group) => (
        <div key={group.category}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <span style={{ fontWeight: 700, fontSize: 13.5 }}>{group.category}</span>
            <button
              type="button"
              onClick={() => setAllInCategory(group.items, true)}
              style={{ background: "none", border: "none", color: ACCENT, fontSize: 12.5, cursor: "pointer", padding: 0 }}
            >
              todos
            </button>
            <span style={{ color: MUTED, fontSize: 12 }}>/</span>
            <button
              type="button"
              onClick={() => setAllInCategory(group.items, false)}
              style={{ background: "none", border: "none", color: ACCENT, fontSize: 12.5, cursor: "pointer", padding: 0 }}
            >
              ninguno
            </button>
          </div>
          <div style={{ display: "grid", gap: 4 }}>
            {group.items.map((item) => (
              <label key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
                {item.name}
              </label>
            ))}
          </div>
        </div>
      ))}
      {error ? (
        <div role="alert" style={{ fontSize: 13, color: ERROR_INK }}>
          {error}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 10 }}>
        <Button variant="primary" size="sm" disabled={pending || unchanged} onClick={submit}>
          {pending ? "Guardando…" : "Guardar"}
        </Button>
        <Button variant="quiet" size="sm" disabled={pending} onClick={cancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

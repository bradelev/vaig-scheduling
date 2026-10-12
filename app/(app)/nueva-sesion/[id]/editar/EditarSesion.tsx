"use client";

/**
 * Edit / move / cancel an existing app-origin session (issue #117). Keeps the
 * same minimal single-screen shape as the create form. Splits the writes by
 * what actually changed: service/note → editSession; start time → moveSession
 * (which resets reminder state on a real change); "Cancelar sesión" →
 * cancelSession. No client typeahead here — reassigning the client is rare and
 * out of this screen's fast path (the client is shown read-only).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { cancelSession, editSession, moveSession } from "@/lib/sessions/actions";
import { ErrorBanner, OkBanner } from "@/app/(app)/_components/Banners";
import { Button } from "@/app/(app)/_components/Button";
import { ACCENT, INK, INPUT_STYLE } from "@/lib/ui/theme";
import type { ServiceType } from "../../page";
import type { EditableSession } from "./page";

// This screen's MUTED differs from the shared theme's (#5b6169 vs #6b665e) —
// kept local on purpose (R6: don't change values, only dedup identical ones).
const MUTED = "#5b6169";

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: MUTED,
  textTransform: "uppercase",
  letterSpacing: "0.03em",
};

/** An ISO instant → the "YYYY-MM-DDTHH:mm" a datetime-local input expects,
 * in the browser's local wall time. */
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Props = { session: EditableSession; services: ServiceType[] };

export default function EditarSesion({ session, services }: Props) {
  const router = useRouter();
  const [startsAt, setStartsAt] = useState(() => isoToLocalInput(session.starts_at));
  const [service, setService] = useState(session.service ?? "");
  const [note, setNote] = useState(session.note ?? "");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const cancelled = session.status === "cancelled";

  async function handleSave() {
    if (busy) return;
    setError(null);
    setDone(null);
    if (!startsAt) {
      setError("Falta la fecha y hora.");
      return;
    }
    setBusy(true);
    try {
      // Only send what changed. editSession covers service/note; moveSession
      // covers the start time (and resets the reminder on a real change).
      const serviceChanged = (session.service ?? "") !== service;
      const noteChanged = (session.note ?? "") !== note;
      if (serviceChanged || noteChanged) {
        const r = await editSession({
          sessionId: session.id,
          ...(serviceChanged ? { service } : {}),
          ...(noteChanged ? { note } : {}),
        });
        if ("error" in r) {
          setError(r.error);
          return;
        }
      }
      const newIso = new Date(startsAt).toISOString();
      if (newIso !== new Date(session.starts_at).toISOString()) {
        const r = await moveSession({ sessionId: session.id, startsAt: newIso });
        if ("error" in r) {
          setError(r.error);
          return;
        }
      }
      setDone("✓ Cambios guardados");
      router.refresh();
    } catch {
      setError("No se pudieron guardar los cambios. Probá de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (busy) return;
    if (!confirm(`¿Cancelar la sesión de ${session.client_name}?`)) return;
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      const r = await cancelSession({ sessionId: session.id });
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setDone("✓ Sesión cancelada");
      router.refresh();
    } catch {
      setError("No se pudo cancelar la sesión. Probá de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 520, margin: "0 auto", padding: "20px 16px 40px" }}>
      <style>{`
        .es-field:focus-visible {
          outline: 2px solid ${ACCENT};
          outline-offset: 2px;
          border-color: ${ACCENT};
        }
      `}</style>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: INK, margin: "0 0 4px" }}>
        Editar sesión
      </h1>
      <p style={{ margin: "0 0 20px", color: MUTED, fontSize: 15 }}>
        {session.client_name}
        {cancelled ? " · cancelada" : ""}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div aria-live="polite">
          {done ? <OkBanner>{done}</OkBanner> : null}
        </div>
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="cuando" style={LABEL_STYLE}>
            Cuándo
          </label>
          <input
            id="cuando"
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            disabled={busy || cancelled}
            className="es-field" style={INPUT_STYLE}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="servicio" style={LABEL_STYLE}>
            Servicio
          </label>
          <select
            id="servicio"
            value={service}
            onChange={(e) => setService(e.target.value)}
            disabled={busy || cancelled}
            className="es-field" style={INPUT_STYLE}
          >
            <option value="">— sin especificar —</option>
            {services.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="nota" style={LABEL_STYLE}>
            Nota
          </label>
          <textarea
            id="nota"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy || cancelled}
            rows={3}
            className="es-field" style={{ ...INPUT_STYLE, minHeight: 66, padding: 12, fontFamily: "inherit" }}
          />
        </div>

        {!cancelled ? (
          <>
            <Button
              type="button"
              variant="primary"
              block
              onClick={handleSave}
              disabled={busy}
            >
              {busy ? "Guardando…" : "Guardar cambios"}
            </Button>
            <Button
              type="button"
              variant="dangerGhost"
              block
              onClick={handleCancel}
              disabled={busy}
            >
              Cancelar sesión
            </Button>
          </>
        ) : null}
      </div>
    </main>
  );
}

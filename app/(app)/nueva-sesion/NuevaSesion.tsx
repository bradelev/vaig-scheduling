"use client";

/**
 * "Nueva sesión" — the single-screen create form (PRD Part II §II.2, issue
 * #117, task v3-T2.2). The UX constraint is non-negotiable: creating a
 * session must not cost more than a Google Calendar event — target <15s.
 * Minimal visible fields (client, when, service), everything else collapsed
 * behind "+ Detalles". Calls the createSession Server Action; no matching
 * logic here.
 */
import { useEffect, useState } from "react";
import { createSession } from "@/lib/sessions/actions";
import { fetchStaffSlots } from "@/lib/booking/actions";
import type { DayAvailability } from "@/lib/booking/availability";
import { slotToLocalInput, slotTimeLabel } from "@/lib/booking/format";
import { type ClientPick, fetchClientsForPicker } from "@/lib/clients/pick";
import { filterClientOptions } from "@/lib/unmatched/resolve";
import type { Staff } from "@/lib/sessions/staff";
import { ErrorBanner, OkBanner, WarnBanner } from "@/app/(app)/_components/Banners";
import { Button } from "@/app/(app)/_components/Button";
import {
  ACCENT,
  BORDER,
  INK,
  INPUT_STYLE,
} from "@/lib/ui/theme";
import type { ServiceType } from "./page";

/** Mobile-friendly cap for the autocomplete result list (mirrors #80). */
const OPTIONS_CAP = 8;

const DEFAULT_DURATION_MINUTES = 60;
const DURATION_OPTIONS = [30, 60, 90, 120];

// This screen's MUTED differs from the shared theme's (#5b6169 vs #6b665e) —
// kept local on purpose (R6: don't change values, only dedup identical ones).
const MUTED = "#5b6169";

type Props = {
  services: ServiceType[];
  staff: Staff[];
};

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: MUTED,
  textTransform: "uppercase",
  letterSpacing: "0.03em",
};

/** Next round hour from `now`: +1h, minutes/seconds/ms zeroed, as a value a
 * `datetime-local` input accepts ("YYYY-MM-DDTHH:mm" in local wall time). */
function nextRoundHourLocal(now: Date): string {
  const d = new Date(now);
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return toLocalInput(d);
}

function optionLabel(c: ClientPick): string {
  return `${c.full_name} · ${c.phone}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** A Date → the "YYYY-MM-DDTHH:mm" a datetime-local input expects (local). */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "hoy" / "mañana" at a given hour — the two most common quick picks, which
 * on a phone save fighting the native date wheel for the common case. */
function dayAtHour(daysFromNow: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  return toLocalInput(d);
}

// Slot formatters (slotToLocalInput / slotTimeLabel) live in
// lib/booking/format.ts so their timezone conversion is unit-tested.

export default function NuevaSesion({ services, staff }: Props) {
  // Clients load in the BACKGROUND so the form is usable instantly (perf
  // 2026-08-17). Until they arrive, the picker shows "cargando clientas…"; once
  // loaded, search is local and instant (small dataset).
  const [clients, setClients] = useState<ClientPick[]>([]);
  const [clientsLoading, setClientsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchClientsForPicker()
      .then((rows) => {
        if (!cancelled) setClients(rows);
      })
      .catch(() => {
        // A load failure isn't fatal — you can still create a NEW client inline.
      })
      .finally(() => {
        if (!cancelled) setClientsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [selectedClientId, setSelectedClientId] = useState("");
  const [clientQuery, setClientQuery] = useState("");
  const [creatingClient, setCreatingClient] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [isFirstVisit, setIsFirstVisit] = useState(true);

  const [startsAt, setStartsAt] = useState(() => nextRoundHourLocal(new Date()));
  // When the operator picks a computed slot we keep its EXACT instant (ISO) and
  // submit that verbatim — bypassing the datetime-local's browser-tz parsing, so
  // a slot the engine offered as 10:00 MVD is booked at 10:00 MVD on any device.
  // Any manual edit / quick-pick clears it → we fall back to the field value
  // (browser-tz, which round-trips consistently for hand-entered times).
  const [pickedInstant, setPickedInstant] = useState<string | null>(null);
  const [service, setService] = useState("");
  const [attendedBy, setAttendedBy] = useState("");

  /** Set "Cuándo" from a hand-entered / quick-pick wall-clock value (browser tz).
   *  Clears any picked-slot instant so submit uses the field, not a stale slot. */
  function setWhenFromField(value: string) {
    setPickedInstant(null);
    setStartsAt(value);
  }

  /** Set "Cuándo" from a computed slot: remember its instant AND mirror it into
   *  the visible field (in Montevideo wall-clock) so the input shows the time. */
  function setWhenFromSlot(iso: string) {
    setPickedInstant(iso);
    setStartsAt(slotToLocalInput(iso));
  }

  const [showDetails, setShowDetails] = useState(false);
  const [durationMinutes, setDurationMinutes] = useState(DEFAULT_DURATION_MINUTES);
  const [note, setNote] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = no result yet; "ok" = created + mirrored to calendar; "no-mirror" =
  // created but the calendar mirror failed (operator should be warned).
  const [success, setSuccess] = useState<null | "ok" | "no-mirror">(null);

  // Optional slot helper (Phase 1C): once a staff member is chosen, we fetch
  // their FREE slots for the current duration so the operator can pick one that
  // won't collide. Purely additive — the datetime-local above still works.
  const [slotDays, setSlotDays] = useState<DayAvailability[] | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);

  // The day the helper shows = the day chosen in the datepicker (startsAt is
  // "YYYY-MM-DDTHH:mm"). We depend on the DAY only, so changing just the hour
  // doesn't refetch.
  const selectedDayKey = startsAt.slice(0, 10);

  useEffect(() => {
    // No staff selected → no helper. Clear any stale slots.
    if (!attendedBy) {
      setSlotDays(null);
      return;
    }
    let cancelled = false;
    setSlotsLoading(true);
    fetchStaffSlots({
      staffId: attendedBy,
      durationMin: durationMinutes,
      dayKey: selectedDayKey,
    })
      .then((res) => {
        if (cancelled) return;
        setSlotDays("error" in res ? [] : res.days);
      })
      .catch(() => {
        if (!cancelled) setSlotDays([]);
      })
      .finally(() => {
        if (!cancelled) setSlotsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attendedBy, durationMinutes, selectedDayKey]);

  const selectedClient = clients.find((c) => c.id === selectedClientId) ?? null;
  const { visible, hidden } = filterClientOptions([], clients, clientQuery, OPTIONS_CAP);

  /** Clear the "✓ Sesión creada" banner as soon as the next entry begins, so
   * it never lingers over a half-filled new session. */
  function dismissSuccess() {
    if (success) setSuccess(null);
  }

  function resetForm() {
    setSelectedClientId("");
    setClientQuery("");
    setCreatingClient(false);
    setNewName("");
    setNewPhone("");
    setIsFirstVisit(true);
    setStartsAt(nextRoundHourLocal(new Date()));
    setPickedInstant(null);
    setService("");
    setAttendedBy("");
    setShowDetails(false);
    setDurationMinutes(DEFAULT_DURATION_MINUTES);
    setNote("");
    setSlotDays(null);
  }

  function startCreatingClient() {
    dismissSuccess();
    setSelectedClientId("");
    setCreatingClient(true);
  }

  function cancelCreatingClient() {
    setCreatingClient(false);
    setNewName("");
    setNewPhone("");
    setIsFirstVisit(true);
  }

  function pickClient(id: string) {
    dismissSuccess();
    setSelectedClientId(id);
    setCreatingClient(false);
  }

  async function handleSubmit() {
    if (busy) return;
    setError(null);
    setSuccess(null);

    const hasClient = creatingClient
      ? newName.trim() !== "" && newPhone.trim() !== ""
      : selectedClientId !== "";
    if (!hasClient) {
      setError("Falta la clienta.");
      return;
    }
    if (!startsAt) {
      setError("Falta la fecha y hora.");
      return;
    }

    setBusy(true);
    try {
      const result = await createSession({
        ...(creatingClient
          ? {
              newClient: {
                fullName: newName,
                phone: newPhone,
                isFirstVisit,
              },
            }
          : { clientId: selectedClientId }),
        // A picked slot carries its exact instant → submit it verbatim (no
        // browser-tz reparse). Hand-entered values go through the field as before.
        startsAt: pickedInstant ?? new Date(startsAt).toISOString(),
        durationMinutes,
        ...(service ? { service } : {}),
        ...(attendedBy ? { attendedBy } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if ("error" in result) {
        setError(result.error);
      } else {
        setSuccess(result.mirrored ? "ok" : "no-mirror");
        resetForm();
      }
    } catch {
      setError("No se pudo crear la sesión. Probá de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 520, margin: "0 auto", padding: "20px 16px 40px" }}>
      {/* Visible keyboard focus (inline styles can't express :focus). Scoped to
          this screen's controls; respects the app's inline-style convention. */}
      <style>{`
        .ns-field:focus-visible {
          outline: 2px solid ${ACCENT};
          outline-offset: 2px;
          border-color: ${ACCENT};
        }
      `}</style>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: INK, margin: "0 0 20px" }}>
        Nueva sesión
      </h1>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Announced to screen readers as they change. */}
        <div aria-live="polite">
          {success === "ok" ? <OkBanner>✓ Sesión creada</OkBanner> : null}
          {success === "no-mirror" ? (
            <WarnBanner>
              ✓ Sesión creada, pero no se pudo escribir en Google Calendar. La
              sesión está en la app y el recordatorio va a salir igual; el evento
              del calendario quedó pendiente (revisá la configuración o
              reintentá desde la agenda).
            </WarnBanner>
          ) : null}
        </div>

        {error ? <ErrorBanner>{error}</ErrorBanner> : null}

        {/* Cliente */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* A section heading, not a form label: the actual labelled control
              differs across the three states (new-client fields / selected /
              search), each with its own htmlFor below. */}
          <span style={LABEL_STYLE}>Cliente</span>
          {creatingClient ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label htmlFor="nuevo-nombre" style={LABEL_STYLE}>
                Nombre
              </label>
              <input
                id="nuevo-nombre"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                disabled={busy}
                className="ns-field" style={INPUT_STYLE}
              />
              <label htmlFor="nuevo-telefono" style={LABEL_STYLE}>
                Teléfono
              </label>
              <input
                id="nuevo-telefono"
                type="text"
                inputMode="tel"
                placeholder="099123456"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                disabled={busy}
                className="ns-field" style={INPUT_STYLE}
              />
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 14,
                }}
              >
                <input
                  type="checkbox"
                  checked={isFirstVisit}
                  onChange={(e) => setIsFirstVisit(e.target.checked)}
                  disabled={busy}
                />
                Primera vez
              </label>
              <Button
                type="button"
                variant="quiet"
                size="sm"
                onClick={cancelCreatingClient}
                disabled={busy}
              >
                ← Elegir de la lista
              </Button>
            </div>
          ) : selectedClient ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                border: "1px solid #1a7a1a",
                background: "#f2faf2",
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 15,
              }}
            >
              <span style={{ fontWeight: 600 }}>{optionLabel(selectedClient)}</span>
              <Button
                type="button"
                variant="quiet"
                size="sm"
                onClick={() => setSelectedClientId("")}
                disabled={busy}
              >
                Cambiar
              </Button>
            </div>
          ) : (
            <>
              <input
                id="cliente"
                type="search"
                placeholder="Buscá por nombre o teléfono…"
                aria-label="Buscar clienta por nombre o teléfono"
                value={clientQuery}
                onChange={(e) => {
                  dismissSuccess();
                  setClientQuery(e.target.value);
                }}
                disabled={busy}
                autoComplete="off"
                className="ns-field" style={INPUT_STYLE}
              />
              {visible.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => pickClient(c.id)}
                  disabled={busy}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    width: "100%",
                    minHeight: 44,
                    padding: "0 12px",
                    fontSize: 15,
                    textAlign: "left",
                    background: "#fff",
                    border: "1px solid #ccc",
                    borderRadius: 8,
                    cursor: "pointer",
                  }}
                >
                  <span>
                    <span style={{ fontWeight: 600 }}>{c.full_name}</span>
                    <span style={{ color: "#555" }}> · {c.phone}</span>
                  </span>
                </button>
              ))}
              {hidden > 0 ? (
                <span style={{ fontSize: 12.5, color: "#777" }}>
                  …y {hidden} más — seguí escribiendo para afinar.
                </span>
              ) : null}
              {visible.length === 0 ? (
                <span style={{ fontSize: 12.5, color: "#777" }}>
                  {clientsLoading
                    ? "Cargando clientas…"
                    : clientQuery.trim() === ""
                    ? "Escribí nombre o teléfono para buscar."
                    : "Sin resultados — probá con menos letras o creá una clienta nueva."}
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={startCreatingClient}
                disabled={busy}
              >
                + Nueva clienta
              </Button>
            </>
          )}
        </div>

        {/* Cuándo */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label htmlFor="cuando" style={LABEL_STYLE}>
            Cuándo
          </label>
          {/* Quick picks — on a phone these skip the native date wheel for the
              two most common cases (this afternoon / tomorrow afternoon). */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[
              { label: "Hoy 15:00", value: dayAtHour(0, 15) },
              { label: "Mañana 10:00", value: dayAtHour(1, 10) },
              { label: "Mañana 15:00", value: dayAtHour(1, 15) },
            ].map((q) => {
              const active = startsAt === q.value;
              return (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => {
                    dismissSuccess();
                    setWhenFromField(q.value);
                  }}
                  disabled={busy}
                  aria-pressed={active}
                  style={{
                    minHeight: 40,
                    padding: "0 14px",
                    fontSize: 14,
                    fontWeight: 600,
                    borderRadius: 999,
                    border: `1px solid ${active ? ACCENT : BORDER}`,
                    background: active ? ACCENT : "#fff",
                    color: active ? "#fff" : INK,
                    cursor: "pointer",
                  }}
                >
                  {q.label}
                </button>
              );
            })}
          </div>
          <input
            id="cuando"
            type="datetime-local"
            value={startsAt}
            onChange={(e) => {
              dismissSuccess();
              setWhenFromField(e.target.value);
            }}
            disabled={busy}
            className="ns-field" style={INPUT_STYLE}
          />
        </div>

        {/* Servicio */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label htmlFor="servicio" style={LABEL_STYLE}>
            Servicio
          </label>
          {services.length === 0 ? (
            // Empty catalog: don't show a lone, mute dropdown — say why.
            <p style={{ margin: 0, fontSize: 14, color: MUTED }}>
              No hay categorías de servicio cargadas. Podés crear la sesión sin
              servicio, o cargá las categorías en la base.
            </p>
          ) : (
            <select
              id="servicio"
              value={service}
              onChange={(e) => {
                dismissSuccess();
                setService(e.target.value);
              }}
              disabled={busy}
              className="ns-field" style={INPUT_STYLE}
            >
              <option value="">— sin especificar —</option>
              {services.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Quién atiende — drives the mirror event's calendar color per employee */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label htmlFor="atiende" style={LABEL_STYLE}>
            Quién atiende
          </label>
          <select
            id="atiende"
            value={attendedBy}
            onChange={(e) => {
              dismissSuccess();
              setAttendedBy(e.target.value);
            }}
            disabled={busy}
            className="ns-field"
            style={INPUT_STYLE}
          >
            <option value="">— sin asignar —</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        {/* Horarios libres — optional helper, only once a staff member is
            chosen. Purely additive: clicking a slot fills "Cuándo" above with a
            time that won't collide with that person's existing sessions. */}
        {attendedBy ? (
          <SlotHelper
            slotDays={slotDays}
            loading={slotsLoading}
            durationMinutes={durationMinutes}
            selected={startsAt}
            disabled={busy}
            onPick={(iso) => {
              dismissSuccess();
              setWhenFromSlot(iso);
            }}
          />
        ) : null}

        {/* + Detalles */}
        <Button
          type="button"
          variant="quiet"
          size="sm"
          onClick={() => setShowDetails((v) => !v)}
          disabled={busy}
        >
          {showDetails ? "− Detalles" : "+ Detalles"}
        </Button>

        {showDetails ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label htmlFor="duracion" style={LABEL_STYLE}>
                Duración
              </label>
              <select
                id="duracion"
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Number(e.target.value))}
                disabled={busy}
                className="ns-field" style={INPUT_STYLE}
              >
                {DURATION_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} min
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
                disabled={busy}
                className="ns-field"
                style={{
                  ...INPUT_STYLE,
                  minHeight: 66,
                  padding: 12,
                  fontFamily: "inherit",
                }}
              />
            </div>
          </div>
        ) : null}

        <Button
          type="button"
          variant="primary"
          block
          onClick={handleSubmit}
          disabled={busy}
        >
          {busy ? "Creando…" : "Crear sesión"}
        </Button>
      </div>
    </main>
  );
}

/** The optional free-slot picker shown under "Quién atiende". Renders the
 * fetched days as groups of clickable time chips; a chip whose instant matches
 * the current "Cuándo" value is highlighted. */
function SlotHelper({
  slotDays,
  loading,
  durationMinutes,
  selected,
  disabled,
  onPick,
}: {
  slotDays: DayAvailability[] | null;
  loading: boolean;
  durationMinutes: number;
  selected: string;
  disabled: boolean;
  onPick: (iso: string) => void;
}) {
  const daysWithSlots = (slotDays ?? []).filter((d) => d.slots.length > 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={LABEL_STYLE}>Horarios libres ({durationMinutes} min)</span>
      {loading ? (
        <span style={{ fontSize: 12.5, color: MUTED }}>
          Calculando horarios libres…
        </span>
      ) : daysWithSlots.length === 0 ? (
        <span style={{ fontSize: 12.5, color: MUTED }}>
          No hay horarios libres ese día para esta persona. Probá otra fecha
          arriba, o poné la hora a mano.
        </span>
      ) : (
        daysWithSlots.map((day) => (
          <div
            key={day.dayKey}
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
          >
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {day.slots.map((s) => {
                const active = selected === slotToLocalInput(s.startsAt);
                return (
                  <button
                    key={s.startsAt}
                    type="button"
                    onClick={() => onPick(s.startsAt)}
                    disabled={disabled}
                    aria-pressed={active}
                    style={{
                      minHeight: 36,
                      padding: "0 12px",
                      fontSize: 13.5,
                      fontWeight: 600,
                      borderRadius: 999,
                      border: `1px solid ${active ? ACCENT : BORDER}`,
                      background: active ? ACCENT : "#fff",
                      color: active ? "#fff" : INK,
                      cursor: "pointer",
                    }}
                  >
                    {slotTimeLabel(s.startsAt)}
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

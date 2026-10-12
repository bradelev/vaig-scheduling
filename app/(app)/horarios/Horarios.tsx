"use client";

/**
 * Hours editor (Phase 1C.2). Pick a staff member, then manage their availability
 * rules in three sections: weekly recurring hours, one-off extra days, and
 * blocks. Purely a CRUD front-end over staff_hours via the hours-actions Server
 * Actions; all validation lives server-side in validateRule (mirrored messages).
 */
import { useEffect, useState } from "react";
import {
  listStaffHours,
  addStaffHour,
  deleteStaffHour,
  type HourRuleRow,
} from "@/lib/booking/hours-actions";
import {
  timeToMin,
  minToTime,
  WEEKDAY_NAMES,
  type RuleDraft,
} from "@/lib/booking/hours-rules";
import { buildWeekMap, type WeeklyRule } from "@/lib/booking/week-map";
import { fetchDateMap } from "@/lib/booking/date-map-actions";
import type { DateMap, CellState } from "@/lib/booking/date-map";
import type { Staff } from "@/lib/sessions/staff";
import { ErrorBanner } from "@/app/(app)/_components/Banners";
import { Button } from "@/app/(app)/_components/Button";
import { ACCENT, BORDER, INK, INPUT_STYLE, LABEL_STYLE, MUTED } from "@/lib/ui/theme";

type Props = { staff: Staff[] };

// Weekly editor lists Monday-first (how people think of a work week), though the
// data uses 0=Sunday..6=Saturday.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export default function Horarios({ staff }: Props) {
  const [staffId, setStaffId] = useState("");
  const [rules, setRules] = useState<HourRuleRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every rule add/remove so the date map (which is server-fetched, not
  // derived from `rules`) reloads to reflect the change.
  const [rulesVersion, setRulesVersion] = useState(0);

  // Load the chosen person's rules whenever the selection changes.
  useEffect(() => {
    if (!staffId) {
      setRules([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listStaffHours(staffId)
      .then((res) => {
        if (cancelled) return;
        if ("error" in res) setError(res.error);
        else setRules(res.rules);
      })
      .catch(() => {
        if (!cancelled) setError("No se pudieron leer los horarios.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [staffId]);

  async function add(draft: RuleDraft) {
    setError(null);
    const res = await addStaffHour({ staffId, draft });
    if ("error" in res) {
      setError(res.error);
      return false;
    }
    setRules((prev) => [...prev, res.rule]);
    setRulesVersion((v) => v + 1);
    return true;
  }

  async function remove(ruleId: string) {
    setError(null);
    // Optimistic: drop it, restore on failure.
    const prev = rules;
    setRules((r) => r.filter((x) => x.id !== ruleId));
    const res = await deleteStaffHour({ staffId, ruleId });
    if ("error" in res) {
      setError(res.error);
      setRules(prev);
    } else {
      setRulesVersion((v) => v + 1);
    }
  }

  const weekly = rules.filter((r) => r.kind === "weekly");
  const opens = rules
    .filter((r) => r.kind === "open")
    .sort((a, b) => (a.on_date ?? "").localeCompare(b.on_date ?? ""));
  const blocks = rules
    .filter((r) => r.kind === "block")
    .sort((a, b) => (a.on_date ?? "").localeCompare(b.on_date ?? ""));

  return (
    <main style={{ maxWidth: 620, margin: "0 auto", padding: "20px 16px 40px" }}>
      <style>{`
        .hr-field:focus-visible {
          outline: 2px solid ${ACCENT};
          outline-offset: 2px;
          border-color: ${ACCENT};
        }
      `}</style>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: INK, margin: "0 0 8px" }}>
        Horarios
      </h1>
      <p style={{ margin: "0 0 20px", fontSize: 14, color: MUTED }}>
        Elegí a la profesional y cargá su disponibilidad. El horario semanal se
        repite todas las semanas; los días extra y los bloqueos son para fechas
        puntuales.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Profesional */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label htmlFor="staff" style={LABEL_STYLE}>
            Profesional
          </label>
          <select
            id="staff"
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
            className="hr-field"
            style={INPUT_STYLE}
          >
            <option value="">— elegí —</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        {error ? <ErrorBanner>{error}</ErrorBanner> : null}

        {!staffId ? null : loading ? (
          <p style={{ fontSize: 14, color: MUTED }}>Cargando horarios…</p>
        ) : (
          <>
            <DateMapView staffId={staffId} rulesVersion={rulesVersion} />
            <WeekMapView weekly={weekly} />
            <WeeklySection weekly={weekly} onAdd={add} onRemove={remove} />
            <OpenSection opens={opens} onAdd={add} onRemove={remove} />
            <BlockSection blocks={blocks} onAdd={add} onRemove={remove} />
          </>
        )}
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ Weekly */

function WeeklySection({
  weekly,
  onAdd,
  onRemove,
}: {
  weekly: HourRuleRow[];
  onAdd: (d: RuleDraft) => Promise<boolean>;
  onRemove: (id: string) => void;
}) {
  const [weekday, setWeekday] = useState<number>(1);
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("13:00");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    const ok = await onAdd({
      kind: "weekly",
      weekday,
      startMin: timeToMin(from),
      endMin: timeToMin(to),
    });
    setSaving(false);
    // Keep the day/times so adding several ranges to one day is quick.
    void ok;
  }

  return (
    <Section
      title="Horario semanal"
      hint="Se repite todas las semanas. Ej: Martes 13:00–20:00."
    >
      {WEEK_ORDER.map((wd) => {
        const rows = weekly
          .filter((r) => r.weekday === wd)
          .sort((a, b) => (a.start_min ?? 0) - (b.start_min ?? 0));
        return (
          <div key={wd} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ width: 92, fontSize: 14, fontWeight: 600, color: INK }}>
              {WEEKDAY_NAMES[wd]}
            </span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {rows.length === 0 ? (
                <span style={{ fontSize: 13, color: MUTED }}>—</span>
              ) : (
                rows.map((r) => (
                  <RangeChip
                    key={r.id}
                    label={`${minToTime(r.start_min!)}–${minToTime(r.end_min!)}`}
                    onRemove={() => onRemove(r.id)}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}

      <AddRow>
        <select
          aria-label="Día de la semana"
          value={weekday}
          onChange={(e) => setWeekday(Number(e.target.value))}
          className="hr-field"
          style={{ ...INPUT_STYLE, width: "auto", flex: "1 1 120px" }}
        >
          {WEEK_ORDER.map((wd) => (
            <option key={wd} value={wd}>
              {WEEKDAY_NAMES[wd]}
            </option>
          ))}
        </select>
        <TimeRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <Button type="button" variant="primary" size="sm" onClick={submit} disabled={saving}>
          {saving ? "…" : "Agregar"}
        </Button>
      </AddRow>
    </Section>
  );
}

/* -------------------------------------------------------------------- Open */

function OpenSection({
  opens,
  onAdd,
  onRemove,
}: {
  opens: HourRuleRow[];
  onAdd: (d: RuleDraft) => Promise<boolean>;
  onRemove: (id: string) => void;
}) {
  const [date, setDate] = useState("");
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("13:00");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    const ok = await onAdd({
      kind: "open",
      onDate: date,
      startMin: timeToMin(from),
      endMin: timeToMin(to),
    });
    setSaving(false);
    if (ok) setDate("");
  }

  return (
    <Section title="Días extra" hint="Disponibilidad para una fecha puntual.">
      {opens.length === 0 ? (
        <Empty />
      ) : (
        opens.map((r) => (
          <ListRow
            key={r.id}
            main={fmtDate(r.on_date!)}
            sub={`${minToTime(r.start_min!)}–${minToTime(r.end_min!)}`}
            onRemove={() => onRemove(r.id)}
          />
        ))
      )}
      <AddRow>
        <DateInput value={date} onChange={setDate} />
        <TimeRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <Button type="button" variant="primary" size="sm" onClick={submit} disabled={saving}>
          {saving ? "…" : "Agregar"}
        </Button>
      </AddRow>
    </Section>
  );
}

/* ------------------------------------------------------------------- Block */

function BlockSection({
  blocks,
  onAdd,
  onRemove,
}: {
  blocks: HourRuleRow[];
  onAdd: (d: RuleDraft) => Promise<boolean>;
  onRemove: (id: string) => void;
}) {
  const [date, setDate] = useState("");
  const [allDay, setAllDay] = useState(true);
  const [from, setFrom] = useState("13:00");
  const [to, setTo] = useState("14:00");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    const ok = await onAdd({
      kind: "block",
      onDate: date,
      startMin: allDay ? null : timeToMin(from),
      endMin: allDay ? null : timeToMin(to),
    });
    setSaving(false);
    if (ok) setDate("");
  }

  return (
    <Section title="Bloqueos" hint="Días o rangos cerrados (vacaciones, franco).">
      {blocks.length === 0 ? (
        <Empty />
      ) : (
        blocks.map((r) => (
          <ListRow
            key={r.id}
            main={fmtDate(r.on_date!)}
            sub={
              r.start_min == null
                ? "Todo el día"
                : `${minToTime(r.start_min)}–${minToTime(r.end_min!)}`
            }
            onRemove={() => onRemove(r.id)}
          />
        ))
      )}
      <AddRow>
        <DateInput value={date} onChange={setDate} />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => setAllDay(e.target.checked)}
          />
          Todo el día
        </label>
        {!allDay ? (
          <TimeRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        ) : null}
        <Button type="button" variant="primary" size="sm" onClick={submit} disabled={saving}>
          {saving ? "…" : "Agregar"}
        </Button>
      </AddRow>
    </Section>
  );
}

/* ---------------------------------------------------------------- date map */

// One-letter weekday headers (Monday-first), indexed by 0=Sunday..6=Saturday.
const WEEKDAY_INITIALS = ["D", "L", "M", "M", "J", "V", "S"];

/** Today's Montevideo day key (YYYY-MM-DD). */
function todayKey(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Shift a YYYY-MM-DD key by N days (via local noon, fixed -03:00). */
function shiftDayKey(dayKey: string, deltaDays: number): string {
  const ms = new Date(`${dayKey}T12:00:00-03:00`).getTime() + deltaDays * 86_400_000;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** The 0..6 (Sun..Sat) weekday for a YYYY-MM-DD (Montevideo). */
function weekdayOf(dayKey: string): number {
  const noon = new Date(`${dayKey}T12:00:00-03:00`);
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Montevideo",
    weekday: "short",
  }).format(noon);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

/** Weekday initial for a YYYY-MM-DD (Montevideo). */
function dayInitial(dayKey: string): string {
  return WEEKDAY_INITIALS[weekdayOf(dayKey)] ?? "";
}

/** The Monday of the calendar week containing `dayKey` (weeks run Mon→Sun). */
function mondayOf(dayKey: string): string {
  const wd = weekdayOf(dayKey); // 0=Sun..6=Sat
  const backToMonday = wd === 0 ? 6 : wd - 1; // Sunday is 6 days after Monday
  return shiftDayKey(dayKey, -backToMonday);
}

/** "31/8" day/month for a column header. */
function dayMonth(dayKey: string): string {
  const [, m, d] = dayKey.split("-");
  return `${Number(d)}/${Number(m)}`;
}

const CELL_COLORS: Record<CellState, string> = {
  available: "#2f9e6b", // green — free/available
  booked: "#1c5cab", // blue — a session is booked here
  off: "transparent", // closed — the striped background shows through
};

function DateMapView({ staffId, rulesVersion }: { staffId: string; rulesVersion: number }) {
  // The week always runs Monday→Sunday; start on the Monday of the current week.
  const [weekStart, setWeekStart] = useState(() => mondayOf(todayKey()));
  const [map, setMap] = useState<DateMap | null>(null);
  const [loading, setLoading] = useState(false);

  // Reload when the person, the week, or the rules change.
  useEffect(() => {
    if (!staffId) {
      setMap(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchDateMap({ staffId, fromDayKey: weekStart })
      .then((res) => {
        if (cancelled) return;
        setMap("error" in res ? null : res.map);
      })
      .catch(() => {
        if (!cancelled) setMap(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [staffId, weekStart, rulesVersion]);

  const today = todayKey();
  const cols = map ? `40px repeat(${map.columns.length}, 1fr)` : "";

  return (
    <Section
      title="Mapa de fechas"
      hint="La semana completa (lun a dom). Verde = disponible · Azul = con turno · Rayado = cerrado."
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <button
          type="button"
          onClick={() => setWeekStart((w) => shiftDayKey(w, -7))}
          aria-label="Semana anterior"
          style={navBtnStyle}
        >
          ‹
        </button>
        <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>
          {map && map.columns.length > 0
            ? `${dayMonth(map.columns[0].dayKey)} – ${dayMonth(map.columns.at(-1)!.dayKey)}`
            : "…"}
        </span>
        <button
          type="button"
          onClick={() => setWeekStart((w) => shiftDayKey(w, 7))}
          aria-label="Semana siguiente"
          style={navBtnStyle}
        >
          ›
        </button>
      </div>

      {loading && !map ? (
        <p style={{ fontSize: 13, color: MUTED, margin: "8px 0 0" }}>Cargando…</p>
      ) : !map ? (
        <p style={{ fontSize: 13, color: MUTED, margin: "8px 0 0" }}>
          No se pudo cargar el mapa.
        </p>
      ) : (
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <div style={{ minWidth: 320 }}>
            {/* Column headers: weekday initial + day/month. Today gets a blue
                circle (Google-Calendar style); past days dim to 50%. */}
            <div style={{ display: "grid", gridTemplateColumns: cols, gap: 2, marginBottom: 3 }}>
              <div />
              {map.columns.map((c) => {
                const isToday = c.dayKey === today;
                const isPast = c.dayKey < today;
                return (
                  <div
                    key={c.dayKey}
                    style={{ textAlign: "center", lineHeight: 1.1, opacity: isPast ? 0.5 : 1 }}
                  >
                    <div style={{ fontSize: 10, fontWeight: 700, color: MUTED }}>
                      {dayInitial(c.dayKey)}
                    </div>
                    {isToday ? (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          minWidth: 22,
                          height: 22,
                          padding: "0 5px",
                          borderRadius: 999,
                          background: ACCENT,
                          color: "#fff",
                          fontSize: 11,
                          fontWeight: 800,
                        }}
                      >
                        {dayMonth(c.dayKey)}
                      </span>
                    ) : (
                      <div style={{ fontSize: 11, fontWeight: 800, color: INK }}>
                        {dayMonth(c.dayKey)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {map.rowMins.map((rowMin) => {
              const onHour = rowMin % 60 === 0;
              return (
                <div
                  key={rowMin}
                  style={{ display: "grid", gridTemplateColumns: cols, gap: 2, marginBottom: 2 }}
                >
                  <div
                    style={{
                      fontSize: 9.5,
                      color: onHour ? INK : "transparent",
                      fontWeight: 600,
                      textAlign: "right",
                      paddingRight: 3,
                      lineHeight: "15px",
                    }}
                  >
                    {onHour ? minToTime(rowMin) : "·"}
                  </div>
                  {map.columns.map((c) => {
                    const state = c.cells[rowMin];
                    const off = state === "off";
                    const isPast = c.dayKey < today;
                    return (
                      <div
                        key={c.dayKey}
                        aria-label={`${dayMonth(c.dayKey)} ${minToTime(rowMin)} ${labelFor(state)}`}
                        style={{
                          height: 15,
                          borderRadius: 3,
                          // Past days dim so the eye skips them but the shape stays.
                          opacity: isPast ? 0.5 : 1,
                          background: off ? undefined : CELL_COLORS[state],
                          backgroundImage: off
                            ? "repeating-linear-gradient(45deg, #e9ebe8 0 3px, #f4f5f3 3px 6px)"
                            : undefined,
                          borderTop: onHour ? "1px solid rgba(0,0,0,0.05)" : "none",
                        }}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 12, color: MUTED, flexWrap: "wrap" }}>
        <LegendSwatch color="#2f9e6b" label="Disponible" />
        <LegendSwatch color="#1c5cab" label="Con turno" />
        <LegendStripe label="Cerrado" />
      </div>
    </Section>
  );
}

function labelFor(s: CellState): string {
  return s === "available" ? "disponible" : s === "booked" ? "con turno" : "cerrado";
}

const navBtnStyle: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 8,
  border: `1px solid ${BORDER}`,
  background: "#fff",
  color: INK,
  fontSize: 20,
  lineHeight: 1,
  cursor: "pointer",
};

function LegendStripe({ label }: { label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          border: "1px solid rgba(0,0,0,0.08)",
          backgroundImage: "repeating-linear-gradient(45deg, #e9ebe8 0 3px, #f4f5f3 3px 6px)",
        }}
      />
      {label}
    </span>
  );
}

/* ---------------------------------------------------------------- week map */

function WeekMapView({ weekly }: { weekly: HourRuleRow[] }) {
  const rules: WeeklyRule[] = weekly
    .filter((r) => r.weekday !== null && r.start_min !== null && r.end_min !== null)
    .map((r) => ({ weekday: r.weekday!, start_min: r.start_min!, end_min: r.end_min! }));

  const map = buildWeekMap(rules);
  const hasAny = rules.length > 0;

  // Grid: a time-label column + 7 day columns.
  const cols = `44px repeat(${map.weekdays.length}, 1fr)`;

  return (
    <Section
      title="Mapa de la semana"
      hint="Cómo queda tu semana típica. Verde = disponible. Cargá abajo para cambiarlo."
    >
      {!hasAny ? (
        <span style={{ fontSize: 13, color: MUTED }}>
          Todavía no cargaste horario semanal. Agregá uno abajo y va a aparecer
          pintado acá.
        </span>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 300 }}>
            {/* Header row: blank corner + weekday initials */}
            <div style={{ display: "grid", gridTemplateColumns: cols, gap: 2, marginBottom: 2 }}>
              <div />
              {map.weekdays.map((wd) => (
                <div
                  key={wd}
                  style={{
                    textAlign: "center",
                    fontSize: 11,
                    fontWeight: 800,
                    color: MUTED,
                    // Weekend columns (Sat=6, Sun=0) a touch dimmer.
                    opacity: wd === 0 || wd === 6 ? 0.7 : 1,
                  }}
                  title={WEEKDAY_NAMES[wd]}
                  aria-label={WEEKDAY_NAMES[wd]}
                >
                  {WEEKDAY_INITIALS[wd]}
                </div>
              ))}
            </div>

            {/* One grid row per half-hour */}
            {map.rowMins.map((rowMin) => {
              const onHour = rowMin % 60 === 0;
              return (
                <div
                  key={rowMin}
                  style={{
                    display: "grid",
                    gridTemplateColumns: cols,
                    gap: 2,
                    marginBottom: 2,
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      color: onHour ? INK : "transparent",
                      fontWeight: 600,
                      textAlign: "right",
                      paddingRight: 4,
                      lineHeight: "16px",
                    }}
                  >
                    {onHour ? minToTime(rowMin) : "·"}
                  </div>
                  {map.weekdays.map((wd) => {
                    const on = map.covered[wd][rowMin];
                    return (
                      <div
                        key={wd}
                        aria-label={`${WEEKDAY_NAMES[wd]} ${minToTime(rowMin)} ${on ? "disponible" : "no disponible"}`}
                        style={{
                          height: 16,
                          borderRadius: 3,
                          background: on ? "#2f9e6b" : "#eef0ee",
                          borderTop: onHour ? "1px solid rgba(0,0,0,0.06)" : "none",
                        }}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Legend */}
      <div style={{ display: "flex", gap: 16, marginTop: 6, fontSize: 12, color: MUTED }}>
        <LegendSwatch color="#2f9e6b" label="Disponible" />
        <LegendSwatch color="#eef0ee" label="Libre / sin cargar" />
      </div>
    </Section>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 14, height: 14, borderRadius: 3, background: color, border: "1px solid rgba(0,0,0,0.08)" }} />
      {label}
    </span>
  );
}

/* -------------------------------------------------------------- primitives */

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        border: `1px solid ${BORDER}`,
        borderRadius: 12,
      }}
    >
      <div>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: INK, margin: 0 }}>{title}</h2>
        <p style={{ margin: "2px 0 0", fontSize: 12.5, color: MUTED }}>{hint}</p>
      </div>
      {children}
    </section>
  );
}

function AddRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "center",
        marginTop: 4,
        paddingTop: 10,
        borderTop: `1px dashed ${BORDER}`,
      }}
    >
      {children}
    </div>
  );
}

function TimeRange({
  from,
  to,
  setFrom,
  setTo,
}: {
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
}) {
  const style: React.CSSProperties = { ...INPUT_STYLE, width: "auto", flex: "0 0 auto" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <input
        type="time"
        aria-label="Desde"
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        className="hr-field"
        style={style}
      />
      <span style={{ color: MUTED }}>–</span>
      <input
        type="time"
        aria-label="Hasta"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        className="hr-field"
        style={style}
      />
    </div>
  );
}

function DateInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="date"
      aria-label="Fecha"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="hr-field"
      style={{ ...INPUT_STYLE, width: "auto", flex: "1 1 150px" }}
    />
  );
}

function RangeChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 8px",
        fontSize: 13,
        fontWeight: 600,
        color: INK,
        background: "#eef4fb",
        border: `1px solid ${BORDER}`,
        borderRadius: 999,
      }}
    >
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Quitar ${label}`}
        style={{
          border: "none",
          background: "none",
          cursor: "pointer",
          color: MUTED,
          fontSize: 15,
          lineHeight: 1,
          padding: 0,
        }}
      >
        ×
      </button>
    </span>
  );
}

function ListRow({
  main,
  sub,
  onRemove,
}: {
  main: string;
  sub: string;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "8px 0",
        borderBottom: `1px solid #f0f0f0`,
      }}
    >
      <span style={{ fontSize: 14, color: INK }}>
        <span style={{ fontWeight: 600 }}>{main}</span>
        <span style={{ color: MUTED }}> · {sub}</span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Quitar ${main}`}
        style={{
          border: "none",
          background: "none",
          cursor: "pointer",
          color: "#a02525",
          fontSize: 14,
          fontWeight: 600,
          minHeight: 32,
          padding: "0 6px",
        }}
      >
        Quitar
      </button>
    </div>
  );
}

function Empty() {
  return <span style={{ fontSize: 13, color: MUTED }}>Nada cargado todavía.</span>;
}

/** "mié 03/09" for a YYYY-MM-DD (Montevideo, Spanish weekday). */
function fmtDate(dayKey: string): string {
  const noon = new Date(`${dayKey}T12:00:00-03:00`);
  const wd = new Intl.DateTimeFormat("es-UY", {
    timeZone: "America/Montevideo",
    weekday: "short",
  }).format(noon);
  const [, m, d] = dayKey.split("-");
  return `${wd} ${d}/${m}`;
}

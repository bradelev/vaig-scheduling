/**
 * Pure validation + shaping for staff_hours rules (Phase 1C.2, the hours
 * editor). Mirrors the per-kind CHECK constraints in migration
 * 20260826140241_availability_engine.sql so the UI rejects a bad rule with a
 * clear Spanish message BEFORE the insert (a raw constraint violation would
 * surface as an opaque Postgres error). No I/O — unit-tested.
 *
 * Times are minutes-from-local-midnight (0..1440), the same unit the column and
 * the slot engine use. weekday is 0=Sunday..6=Saturday.
 */

export type RuleKind = "weekly" | "open" | "block";

/** A rule as the editor builds it, before insert. */
export type RuleDraft = {
  kind: RuleKind;
  /** For 'weekly': 0..6. Null/omitted for 'open'/'block'. */
  weekday?: number | null;
  /** For 'open'/'block': "YYYY-MM-DD". Null/omitted for 'weekly'. */
  onDate?: string | null;
  /** Minutes from midnight. Both null on an all-day 'block'. */
  startMin?: number | null;
  endMin?: number | null;
};

/** The row shape the DB expects (snake_case, nulls explicit). */
export type RuleInsert = {
  kind: RuleKind;
  weekday: number | null;
  on_date: string | null;
  start_min: number | null;
  end_min: number | null;
};

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a draft and normalize it to the DB row shape, or return a Spanish
 * error. Enforces exactly what the migration's CHECK constraints do:
 *  - weekly : weekday 0..6, no date, both mins set, start < end.
 *  - open   : date set, no weekday, both mins set, start < end.
 *  - block  : date set, no weekday; EITHER both mins null (all day) OR both set
 *             with start < end.
 *
 * Note: the "wrong" field for a kind (e.g. an onDate on a weekly draft, or a
 * weekday on an open draft) is NORMALIZED away — hardcoded to null in the output
 * row — not rejected. So the both-set combination the shape constraints forbid
 * can never be sent. The UI never produces such drafts anyway.
 */
export function validateRule(
  draft: RuleDraft,
): { ok: true; row: RuleInsert } | { ok: false; error: string } {
  const { kind } = draft;
  const start = draft.startMin ?? null;
  const end = draft.endMin ?? null;
  const weekday = draft.weekday ?? null;
  const onDate = draft.onDate ?? null;

  const rangeOk = (s: number | null, e: number | null) =>
    s !== null &&
    e !== null &&
    Number.isInteger(s) &&
    Number.isInteger(e) &&
    s >= 0 &&
    e <= 1440 &&
    s < e;

  if (kind === "weekly") {
    if (weekday === null || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { ok: false, error: "Elegí un día de la semana." };
    }
    if (!rangeOk(start, end)) {
      return { ok: false, error: "El horario de fin tiene que ser mayor al de inicio." };
    }
    return {
      ok: true,
      row: { kind, weekday, on_date: null, start_min: start, end_min: end },
    };
  }

  if (kind === "open") {
    if (!onDate || !DAY_KEY_RE.test(onDate)) {
      return { ok: false, error: "Elegí una fecha." };
    }
    if (!rangeOk(start, end)) {
      return { ok: false, error: "El horario de fin tiene que ser mayor al de inicio." };
    }
    return {
      ok: true,
      row: { kind, weekday: null, on_date: onDate, start_min: start, end_min: end },
    };
  }

  // block
  if (!onDate || !DAY_KEY_RE.test(onDate)) {
    return { ok: false, error: "Elegí una fecha." };
  }
  const allDay = start === null && end === null;
  if (!allDay && !rangeOk(start, end)) {
    return {
      ok: false,
      error: "Poné un rango válido (fin mayor al inicio) o dejalo vacío para todo el día.",
    };
  }
  return {
    ok: true,
    row: {
      kind,
      weekday: null,
      on_date: onDate,
      start_min: allDay ? null : start,
      end_min: allDay ? null : end,
    },
  };
}

/** "HH:MM" (from a <input type=time>) → minutes from midnight, or null. */
export function timeToMin(hhmm: string): number | null {
  const m = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** minutes from midnight → "HH:MM" for a <input type=time> value. */
export function minToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Spanish weekday name for 0..6 (0=Sunday), for the weekly editor rows. */
export const WEEKDAY_NAMES = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
];

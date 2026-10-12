/**
 * Pure helpers for the Clients view (PRD FR-4, issue E3-T2). No I/O — the
 * page does the Supabase reads and passes rows in. Kept testable so search,
 * badges and the health indicator are verified without a stack.
 */
import { normalizeText } from "../normalize";

const HOUR_MS = 3_600_000;

export type ClientStatusRow = {
  id: string;
  full_name: string;
  phone: string;
  opted_out: boolean;
  last_session_at: string | null;
  last_service: string | null;
  next_session_at: string | null;
  next_session_id: string | null;
  next_status: string | null;
  next_confirmed_at: string | null;
  days_since_last: number | null;
  /** Source of the next session ('external' | 'manual' | …), issue #89. */
  next_source: string | null;
  /**
   * FR-2's external_covers_same_day, computed in the view (issue #89): a
   * scheduled External session shares the next session's Montevideo day —
   * External reminds it, VAIG never will.
   */
  next_external_covered: boolean | null;
  /** Public reservation awaiting STAFF confirmation (Phase 2). Not a view
   *  column — the page sets it from sessions.pending_confirmation. */
  next_pending_confirmation?: boolean;
  /**
   * First booking on a LATER Montevideo day than the next session (issue
   * #92) — same-day twins/second services excluded in the view. Null means
   * "nothing after": the desk's rebooking signal.
   */
  next2_session_at: string | null;
};

export type JobRun = {
  job: string;
  ok: boolean | null;
  finished_at: string | null;
};

export type SessionBadge =
  | "unconfirmed" // public reservation the TEAM hasn't confirmed yet
  | "confirmed"
  | "pending"
  | "reschedule"
  | "external"
  | "none";

/**
 * Partial name/phone search (PRD FR-4). Name is matched on normalized text
 * (accent- and case-insensitive); phone on its digits so a query like "091"
 * or "1234" matches inside the E.164 value. Only needs name+phone, so the
 * Sin identificar autocomplete reuses it (issue #80) — search semantics
 * stay identical across both screens.
 */
export function matchesQuery(
  row: Pick<ClientStatusRow, "full_name" | "phone">,
  query: string,
): boolean {
  const q = query.trim();
  if (q === "") return true;
  const nameHit = normalizeText(row.full_name).includes(normalizeText(q));
  const qDigits = q.replace(/\D/g, "");
  // Match phone digits, tolerating local notation: a leading 0 (as in
  // "091234567") is not present in the stored E.164 (+59891234567), so try
  // the query with the leading 0 stripped too.
  const rowDigits = row.phone.replace(/\D/g, "");
  const withoutLeadingZero = qDigits.replace(/^0/, "");
  const phoneHit = qDigits !== "" &&
    (rowDigits.includes(qDigits) ||
      // Local notation: "091234567" → the stored E.164 has no leading 0.
      // Guard against a lone "0" (its stripped form "" matches everyone).
      (withoutLeadingZero !== "" && rowDigits.includes(withoutLeadingZero)));
  return nameHit || phoneHit;
}

/**
 * Next-session badge from the view row (PRD FR-4):
 * confirmed (✓) / pending / reschedule (🔁) / External / none.
 * "External" (issue #89) means that session is reminded by External, never by
 * VAIG — "pendiente" there would promise a confirmation that cannot arrive.
 * A real confirmation or reschedule still wins: those are client signals,
 * strictly stronger than who owns the reminder.
 */
export function sessionBadge(row: ClientStatusRow): SessionBadge {
  if (row.next_status === "reschedule_requested") return "reschedule";
  if (!row.next_session_at) return "none";
  // Staff-side state first: until the team confirms a public reservation it
  // is not a firm appointment, whatever the client-side reminder state.
  if (row.next_pending_confirmation) return "unconfirmed";
  if (row.next_confirmed_at) return "confirmed";
  return row.next_external_covered ? "external" : "pending";
}

export const BADGE_LABEL: Record<SessionBadge, string> = {
  unconfirmed: "por confirmar",
  confirmed: "✓ confirmada",
  pending: "pendiente",
  reschedule: "🔁 pidió reagendar",
  external: "External",
  none: "sin próxima",
};

/** Rows that asked to reschedule — the quick filter (PRD FR-4). */
export function askedToReschedule(row: ClientStatusRow): boolean {
  return sessionBadge(row) === "reschedule";
}

/** How many days without re-booking make a client "cold" — Reactivación's floor. */
export const REACTIVATION_DAYS = 21;
/** Grace after a session before "left without a next date" applies (issue #107). */
export const REBOOK_GRACE_DAYS = 3;

/**
 * Retention follow-up list (issue #107): a client who was attended recently
 * but left WITHOUT a next session — the early-catch gap before she goes
 * cold. Attended between REBOOK_GRACE_DAYS and REACTIVATION_DAYS ago, no
 * upcoming session, not opted out. Strictly earlier than Reactivación
 * (>21 days), so the two lists never overlap: this is "offer a date before
 * she cools", that is "win her back".
 */
export function needsRebookFollowup(row: ClientStatusRow): boolean {
  if (row.next_session_at !== null) return false; // already rebooked
  if (row.opted_out) return false;
  if (row.days_since_last === null) return false; // never attended
  return row.days_since_last >= REBOOK_GRACE_DAYS &&
    row.days_since_last <= REACTIVATION_DAYS;
}

/**
 * Rebooking rate over a set of PAST sessions (issue #107): the share whose
 * client has ANY later non-cancelled session (External counts — a rebooking
 * is a rebooking whatever the channel). Sessions inside the grace window
 * are excluded (no time to rebook yet). Pure: the caller supplies past
 * sessions and, per client, their later-session flag.
 */
export type PastSession = {
  client_id: string;
  starts_at: string;
  has_later: boolean;
};

export function rebookingRate(
  past: PastSession[],
  nowMs: number,
): { evaluable: number; rebooked: number; rate: number | null } {
  const graceMs = REBOOK_GRACE_DAYS * 24 * HOUR_MS;
  let evaluable = 0;
  let rebooked = 0;
  for (const p of past) {
    if (new Date(p.starts_at).getTime() > nowMs - graceMs) continue;
    evaluable++;
    if (p.has_later) rebooked++;
  }
  return {
    evaluable,
    rebooked,
    rate: evaluable === 0 ? null : rebooked / evaluable,
  };
}

/**
 * Label for the "luego: …" line (issue #92): "mié 05/08" in Montevideo, or
 * null when there is no later-day booking (that absence IS the rebooking
 * signal). Weekday via es-UY, day/month padded by hand — ICU's flexible
 * matching makes "2-digit" unreliable across locales (same rationale as
 * formatReminderDate in send-reminders).
 */
export function nextAgainLabel(row: ClientStatusRow): string | null {
  if (!row.next2_session_at) return null;
  return weekdayDayMonth(row.next2_session_at);
}

/** "mié 05/08" in Montevideo — shared by the luego line and day headers. */
function weekdayDayMonth(iso: string): string {
  const date = new Date(iso);
  const weekday = new Intl.DateTimeFormat("es-UY", {
    timeZone: "America/Montevideo",
    weekday: "short",
  })
    .format(date)
    .replaceAll(".", "");
  const [, month, day] = mvdDayKey(date.getTime()).split("-");
  return `${weekday} ${day}/${month}`;
}

/** Montevideo calendar day as YYYY-MM-DD — the grouping key. */
function mvdDayKey(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/**
 * Day-group header label (issue #97): "Hoy · lun 27/07", "Mañana · …",
 * plain "mié 29/07" beyond — the desk's vocabulary, Montevideo days.
 */
export function dayGroupLabel(iso: string, nowMs: number): string {
  const day = mvdDayKey(new Date(iso).getTime());
  if (day === mvdDayKey(nowMs)) return `Hoy · ${weekdayDayMonth(iso)}`;
  if (day === mvdDayKey(nowMs + 24 * HOUR_MS)) {
    return `Mañana · ${weekdayDayMonth(iso)}`;
  }
  return weekdayDayMonth(iso);
}

/** "09:00" in Montevideo — inside a day group the header carries the date. */
export function formatTimeOnly(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour").padStart(2, "0")}:${get("minute").padStart(2, "0")}`;
}

/** An upcoming calendar session the system could not identify (issue #99). */
export type GhostSession = { id: string; raw_title: string; starts_at: string };

export type AgendaItem =
  | { kind: "client"; row: ClientStatusRow }
  | { kind: "ghost"; ghost: GhostSession };

export type DayGroup = {
  key: string;
  label: string;
  items: AgendaItem[];
  clients: number;
  ghosts: number;
};

/**
 * Whether a ghost falls on the NEXT Montevideo day (issue #101): the
 * unidentified sessions the team must resolve before the 16:00 batch, so
 * they get a reminder. Twin of pendingConfirmTomorrow's window.
 */
export function ghostIsTomorrow(g: GhostSession, nowMs: number): boolean {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
  const from = new Date(`${today}T00:00:00-03:00`).getTime() + 24 * HOUR_MS;
  const t = new Date(g.starts_at).getTime();
  return t >= from && t < from + 24 * HOUR_MS;
}

/** Search over ghost rows (issue #99): same normalization as names. */
export function ghostMatchesQuery(g: GhostSession, query: string): boolean {
  const q = query.trim();
  if (q === "") return true;
  return normalizeText(g.raw_title).includes(normalizeText(q));
}

/**
 * The day agenda (issues #97/#99): client rows and upcoming unidentified
 * ghosts interleaved chronologically into consecutive Montevideo-day
 * groups, so a day header tells the WHOLE truth of that day. Rows without
 * an upcoming session land in a final "Sin próxima sesión" group. At equal
 * instants the client row renders before the ghost (stable sort, clients
 * listed first). Pure — composes with search filtering on both inputs.
 */
export function groupAgendaByDay(
  rows: ClientStatusRow[],
  ghosts: GhostSession[],
  nowMs: number,
): DayGroup[] {
  type Entry = { sortKey: string; iso: string | null; item: AgendaItem };
  const entries: Entry[] = [
    ...rows.map((row): Entry => ({
      // "~" sorts after any ISO digit → no-next rows keep their tail spot
      // (and their alphabetical order, via sort stability).
      sortKey: row.next_session_at ?? "~",
      iso: row.next_session_at,
      item: { kind: "client", row },
    })),
    ...ghosts.map((ghost): Entry => ({
      sortKey: ghost.starts_at,
      iso: ghost.starts_at,
      item: { kind: "ghost", ghost },
    })),
  ];
  // BYTE-order compare, not localeCompare: locale collation sorts the "~"
  // sentinel before digits (punctuation first), which would put the
  // no-next group on top. Code-unit order is chronologically correct for
  // PostgREST's uniform timestamptz strings AND ranks "~" after them.
  entries.sort((a, b) =>
    a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0
  );

  const groups: DayGroup[] = [];
  for (const e of entries) {
    const key = e.iso ? mvdDayKey(new Date(e.iso).getTime()) : "none";
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(e.item);
      if (e.item.kind === "ghost") last.ghosts++;
      else last.clients++;
    } else {
      groups.push({
        key,
        label: e.iso ? dayGroupLabel(e.iso, nowMs) : "Sin próxima sesión",
        items: [e.item],
        clients: e.item.kind === "client" ? 1 : 0,
        ghosts: e.item.kind === "ghost" ? 1 : 0,
      });
    }
  }
  return groups;
}

/**
 * "Sin confirmar mañana": the next session falls on the NEXT Montevideo
 * calendar day (mirroring FR-2's window since issue #78 — twin of
 * nextLocalDayWindow in supabase/functions/send-reminders/logic.ts) and is
 * still unconfirmed — exactly who the operator would nudge manually if the
 * reminder didn't land. External-covered sessions are excluded via the badge
 * (issue #89): those clients were never asked by VAIG and cannot answer.
 * Uruguay abolished DST in 2015, so the fixed -03:00 offset is exact.
 */
export function pendingConfirmTomorrow(
  row: ClientStatusRow,
  nowMs: number,
): boolean {
  if (sessionBadge(row) !== "pending" || !row.next_session_at) return false;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
  const from = new Date(`${today}T00:00:00-03:00`).getTime() + 24 * HOUR_MS;
  const next = new Date(row.next_session_at).getTime();
  return next >= from && next < from + 24 * HOUR_MS;
}

/**
 * Operational order (issue #49): clients WITH an upcoming session first,
 * soonest first; everyone else after, alphabetically. Stable and pure —
 * used with [...rows].sort(operationalCompare).
 */
export function operationalCompare(
  a: ClientStatusRow,
  b: ClientStatusRow,
): number {
  if (a.next_session_at && b.next_session_at) {
    // Lexical compare is chronologically correct ONLY because PostgREST
    // serializes every timestamptz with a uniform UTC offset (no custom
    // db TimeZone anywhere). A non-UTC db-tz would silently break this.
    return a.next_session_at.localeCompare(b.next_session_at); // ISO asc
  }
  if (a.next_session_at) return -1;
  if (b.next_session_at) return 1;
  return a.full_name.localeCompare(b.full_name, "es");
}

/** The jobs the system runs — both must ALWAYS appear in the health line. */
export const EXPECTED_JOBS: readonly { job: string; staleAfterMs: number }[] = [
  { job: "sync-calendar", staleAfterMs: 2 * HOUR_MS }, // hourly + margin
  { job: "send-reminders", staleAfterMs: 26 * HOUR_MS }, // daily + margin
];

export type HealthState = "ok" | "stale" | "never";
export type HealthEntry = {
  job: string;
  finished_at: string | null;
  state: HealthState;
};

/**
 * Health per expected job (PRD FR-4, issue #49): newest OK finish time, with
 * a "never" state when the job has no successful run at all (its absence is
 * exactly when seeing it matters) and "stale" when the last OK run is older
 * than the job's cadence + margin.
 */
export function health(jobRuns: JobRun[], nowMs: number): HealthEntry[] {
  // Only OK runs with a finish time are inserted, so values are never null.
  const latest = new Map<string, string>();
  for (const run of jobRuns) {
    if (run.ok !== true || !run.finished_at) continue;
    const prev = latest.get(run.job);
    if (prev === undefined || run.finished_at > prev) {
      latest.set(run.job, run.finished_at);
    }
  }
  return EXPECTED_JOBS.map(({ job, staleAfterMs }) => {
    const finished = latest.get(job) ?? null;
    const state: HealthState = !finished
      ? "never"
      : nowMs - new Date(finished).getTime() > staleAfterMs
      ? "stale"
      : "ok";
    return { job, finished_at: finished, state };
  });
}

/**
 * Human-readable Montevideo timestamp for the health line, e.g.
 * "17/07 14:30". Customer/staff-facing (Spanish output).
 */
export function formatWhen(iso: string | null): string {
  if (!iso) return "sin datos";
  // en-CA gives reliable zero-padded parts; es-UY drops the leading zero on
  // the month in some ICU builds (Node vs Deno differ). Pad by hand.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) =>
    (parts.find((p) => p.type === t)?.value ?? "").padStart(2, "0");
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}

/**
 * Pure classification (§7.0) and matching-cascade (§7.2) logic for
 * sync-calendar (PRD FR-1, issue E2-T3). No I/O — every branch is
 * unit-testable under `deno test` against the E2-T2 fixtures.
 *
 * Architect-owned per CLAUDE.md (matching + classification are never
 * delegated). Imports the §7.1 primitives from lib/normalize; Deno resolves
 * the relative path and the deploy bundles the whole graph.
 */
import {
  EMPLOYEES,
  NON_SESSION_PATTERNS,
  normalizePhone,
  normalizeText,
  tokens,
} from "../../../lib/normalize.ts";

const EXTERNAL_PREFIX_RE = /^external\s*-\s*cita con\s*/i;
// `^{employee}\s+no\b` over normalized text (§7.0.2). Word boundary so
// "iara nofretiti" (hypothetical client) is NOT read as availability.
const EMPLOYEE_NO_RE = new RegExp(`^(?:${EMPLOYEES.join("|")})\\s+no\\b`);

export type RawEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
};

export type DiscardReason =
  | "all_day"
  | "employee_availability"
  | "admin_chore"
  | "app_managed";

export type ClassifiedEvent =
  | { kind: "discard"; reason: DiscardReason; id: string; summary: string }
  | {
    kind: "session";
    id: string;
    source: "external" | "manual";
    /** null only for a cancelled tombstone with no start (handled in run). */
    starts_at: string | null;
    ends_at: string | null;
    raw_title: string;
    raw_description: string | null;
    status: "scheduled" | "cancelled";
  };

/**
 * §7.0: is this event a session at all? All-day events, employee
 * availability (`{employee} no …`) and admin chores are discarded before
 * any normalization or matching. Cancelled events are still classified —
 * the caller upserts them as `status='cancelled'`, it just never matches.
 */
/** Marker written by calendar-write (#118) on every app-created mirror event. */
const APP_MARKER_KEY = "vaigApp";
const APP_MARKER_VALUE = "1";

export function classify(ev: RawEvent): ClassifiedEvent {
  const summary = ev.summary ?? "";
  const cancelled = ev.status === "cancelled";

  // App-managed mirror events (#118, PRD §II.7) are OURS: the app session is
  // the source of truth and already exists in the DB. Skip them as a session
  // source before anything else — re-ingesting a mirror would create a second
  // session for the same appointment (double reminders). external/manual events
  // (no marker) fall through to the normal cascade.
  if (ev.extendedProperties?.private?.[APP_MARKER_KEY] === APP_MARKER_VALUE) {
    return { kind: "discard", reason: "app_managed", id: ev.id, summary };
  }

  // A bare tombstone { id, status:"cancelled" } (no start/summary, from
  // showDeleted=true) can only flip an existing row: emit a cancelled
  // session with starts_at=null and let the caller route it to an update.
  // A cancellation for something never synced updates nothing.
  if (cancelled && !ev.start?.dateTime && !ev.start?.date) {
    return {
      kind: "session",
      id: ev.id,
      source: "manual",
      starts_at: null,
      ends_at: null,
      raw_title: summary,
      raw_description: ev.description ?? null,
      status: "cancelled",
    };
  }

  // Discards win over cancellation for shapes that were never sessions: an
  // all-day / availability / chore event was never inserted while scheduled,
  // so its cancellation has no scheduled row to stop and no reason to create
  // an inert cancelled row.
  // 1. All-day events carry `date`, not `dateTime` (holidays, closures).
  if (ev.start?.date || !ev.start?.dateTime) {
    return { kind: "discard", reason: "all_day", id: ev.id, summary };
  }
  const normalized = normalizeText(summary);
  // 2. Employee availability.
  if (EMPLOYEE_NO_RE.test(normalized)) {
    return { kind: "discard", reason: "employee_availability", id: ev.id, summary };
  }
  // 3. Admin chores.
  if (NON_SESSION_PATTERNS.some((p) => p.test(normalized))) {
    return { kind: "discard", reason: "admin_chore", id: ev.id, summary };
  }

  // A real session (scheduled, or cancelled but session-shaped: it may have
  // been synced while scheduled, so its cancellation must reach the row).
  const source: "external" | "manual" = EXTERNAL_PREFIX_RE.test(summary)
    ? "external"
    : "manual";
  return {
    kind: "session",
    id: ev.id,
    source,
    starts_at: ev.start.dateTime,
    ends_at: ev.end?.dateTime ?? null,
    raw_title: summary,
    raw_description: ev.description ?? null,
    status: cancelled ? "cancelled" : "scheduled",
  };
}

/**
 * Text used for matching a session: the External prefix is stripped so
 * "External - Cita con Ana Motta" tokenizes as "ana motta", not "cita con …"
 * (§7.2 / FR-1). Manual titles pass through untouched.
 */
export function matchableText(source: string, rawTitle: string): string {
  return source === "external" ? rawTitle.replace(EXTERNAL_PREFIX_RE, "") : rawTitle;
}

/**
 * Every distinct valid Uruguayan phone appearing in title+description,
 * in first-seen order (§7.2.1 uses "the first phone that … exists in
 * clients"). Scans 8–11 digit runs so unbracketed External numbers and
 * `09…` manual numbers are both found.
 */
export function extractPhones(title: string, description: string | null): string[] {
  const haystack = `${title} ${description ?? ""}`;
  const out: string[] = [];
  for (const run of haystack.match(/\d{8,}/g) ?? []) {
    const e164 = normalizePhone(run);
    if (e164 && !out.includes(e164)) out.push(e164);
  }
  return out;
}

export type MatchInput = {
  phones: string[];
  eventTokens: string[];
};

export type ClientLite = { id: string; phone: string };
export type AliasLite = { client_id: string; alias_tokens: string[] };

export type MatchResult =
  | {
    method: "phone";
    client_id: string;
    /** non-null when a phone_match alias should be learned (§7.2.1 bonus) */
    learnAlias: string[] | null;
  }
  | { method: "alias"; client_id: string; learnAlias: null }
  | { method: null; client_id: null; learnAlias: null; candidates: string[] };

/**
 * §7.2 cascade for a single event. Pure: the caller supplies the client /
 * alias lookups it already loaded. No fuzzy matching (§3) — phone is exact,
 * alias is exact token-subset with a strict "exactly one" rule.
 */
export function matchEvent(
  input: MatchInput,
  clientsByPhone: Map<string, string>,
  aliases: AliasLite[],
): MatchResult {
  // 1. Phone: first phone that normalizes valid AND exists in clients.
  for (const phone of input.phones) {
    const clientId = clientsByPhone.get(phone);
    if (clientId) {
      // Learning bonus: teach an alias from the event tokens if any exist.
      const learn = input.eventTokens.length > 0 ? input.eventTokens : null;
      return { method: "phone", client_id: clientId, learnAlias: learn };
    }
  }

  // 2. Alias: clients whose alias_tokens ⊆ event tokens. Exactly one wins.
  if (input.eventTokens.length > 0) {
    const eventSet = new Set(input.eventTokens);
    const matched = new Set<string>();
    for (const alias of aliases) {
      if (
        alias.alias_tokens.length > 0 &&
        alias.alias_tokens.every((t) => eventSet.has(t))
      ) {
        matched.add(alias.client_id);
      }
    }
    if (matched.size === 1) {
      return { method: "alias", client_id: [...matched][0], learnAlias: null };
    }
    if (matched.size > 1) {
      // Ambiguous: queue, but surface the candidates for the UI (§7.2.3).
      return { method: null, client_id: null, learnAlias: null, candidates: [...matched] };
    }
  }

  // 3. Queue.
  return { method: null, client_id: null, learnAlias: null, candidates: [] };
}

/** Only the last 4 digits of any phone ever reach logs (CLAUDE.md rule). */
export function redactPhones(text: string): string {
  return text.replace(/\d{7,}/g, (m) => `***${m.slice(-4)}`);
}

/**
 * Run `fn` over `items` in slices of `size` and concatenate the results in
 * order (issue #88). PostgREST `.in()` filters travel in the URL: a 90-day
 * backfill carries enough gcal ids to blow past the URL length limit and
 * fail with a bare "Bad Request" — every adapter that filters by an
 * unbounded id list must go through this.
 */
export async function chunked<T, R>(
  items: T[],
  size: number,
  fn: (slice: T[]) => Promise<R[]>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await fn(items.slice(i, i + size)));
  }
  return out;
}

export { matchableText as _matchableText, tokens };

/**
 * Pure logic for manual resolution of unmatched sessions (PRD §7.3, FR-4
 * Unmatched, issue E3-T3). No I/O — the page/actions do the Supabase reads
 * and writes. Reuses the §7.2 alias rule (alias_tokens ⊆ event tokens) so
 * manual resolution and the sync cascade stay consistent. Matching logic is
 * architect-owned (never delegated).
 */
import { matchesQuery } from "../clients/status";
import { normalizePhone, normalizeText, tokens } from "../normalize";

/**
 * Live search over a queued session's raw title (issue #109): the front
 * desk searches by what the calendar event says ("mica 15:30 piernas"), so
 * match on the normalized raw title — accent- and case-insensitive, same
 * normalization as everywhere else. Empty query matches all.
 */
export function titleMatchesQuery(rawTitle: string, query: string): boolean {
  const q = query.trim();
  if (q === "") return true;
  return normalizeText(rawTitle).includes(normalizeText(q));
}

export type UnmatchedSession = {
  id: string;
  gcal_event_id: string;
  starts_at: string;
  service: string | null;
  raw_title: string;
  raw_description: string | null;
  source: string;
};

export type AliasLite = { client_id: string; alias_tokens: string[] };

/** Strip the External prefix before tokenizing (same as the sync). */
const EXTERNAL_PREFIX_RE = /^external\s*-\s*cita con\s*/i;
export function matchableText(source: string, rawTitle: string): string {
  return source === "external" ? rawTitle.replace(EXTERNAL_PREFIX_RE, "") : rawTitle;
}

/** Tokens used to match/learn from an unmatched session (§7.1/§7.2). */
export function sessionTokens(s: UnmatchedSession): string[] {
  return tokens(matchableText(s.source, s.raw_title));
}

/**
 * Name + phone a External title carries, ready to PREFILL the create-client
 * form (issue #111) — a human still reviews and confirms, this only saves
 * retyping. "External - Cita con {name} {phone}": strip the prefix, take the
 * first VALID Uruguayan phone (normalizePhone rejects foreign numbers, so
 * those never prefill), name = the rest with the phone (and the separator
 * punctuation service codes leave behind) removed. Returns null when there
 * is no usable phone — the team creates manually.
 *
 * Assumes the phone is a CONTIGUOUS digit run (real External titles are
 * unbracketed 11-digit `598…`, see fixtures/README). A space-separated
 * phone would split below 7 digits and yield no prefill — a safe
 * false-negative (manual fallback), not a wrong prefill.
 */
export function externalPrefill(
  source: string,
  rawTitle: string,
): { name: string; phone: string } | null {
  if (source !== "external") return null;
  const body = matchableText(source, rawTitle);
  let phone: string | null = null;
  for (const run of body.match(/\d{7,}/g) ?? []) {
    const e164 = normalizePhone(run);
    if (e164) {
      phone = e164;
      break;
    }
  }
  if (!phone) return null;
  const name = body
    .replace(/\d[\d\s.-]*\d|\d/g, " ") // phone and other digit runs
    .replace(/[./\\-]+/g, " ") // separators service codes leave ("3/8" → "cc")
    .replace(/\s+/g, " ")
    .trim();
  if (name === "") return null;
  return { name, phone };
}

/** The alias a session would learn — shown editable in the UI (§7.3). */
export function previewTokens(
  s: Pick<UnmatchedSession, "raw_title" | "source">,
): string[] {
  return tokens(matchableText(s.source, s.raw_title));
}

/** alias_tokens ⊆ event tokens (§7.2 step 2). Empty alias never matches. */
export function aliasMatches(aliasTokens: string[], eventTokens: string[]): boolean {
  if (aliasTokens.length === 0) return false;
  const set = new Set(eventTokens);
  return aliasTokens.every((t) => set.has(t));
}

/**
 * Ambiguous candidates for an unmatched session (§7.2 step 2): the clients
 * whose alias is a token-subset of this session. Surfaced on top of the
 * client dropdown (FR-4). De-duplicated by client_id, order-stable.
 */
export function candidatesFor(
  session: UnmatchedSession,
  aliases: AliasLite[],
): string[] {
  const eventTokens = sessionTokens(session);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of aliases) {
    if (aliasMatches(a.alias_tokens, eventTokens) && !seen.has(a.client_id)) {
      seen.add(a.client_id);
      out.push(a.client_id);
    }
  }
  return out;
}

/** What the client autocomplete needs to search and render (issue #80). */
export type PickableClient = { id: string; full_name: string; phone: string };

/**
 * Name-based candidates (issue #83): clients whose full-name tokens are a
 * subset of the event tokens — the same strict rule as aliases (§7.2), so
 * still no fuzzy matching. Requires ≥2 name tokens AFTER tokenization: a
 * lone first name ("euge") would suggest half the book, and a name whose
 * words are stopwords ("Maria Manos" → ["maria"]) collapses below the bar
 * and is safely never suggested. Not self-deduped — callers rely on
 * allCandidatesFor's Set. Suggestion-only; assignment stays human.
 */
export function nameCandidatesFor(
  session: UnmatchedSession,
  clients: { id: string; full_name: string }[],
): string[] {
  const eventTokens = new Set(sessionTokens(session));
  const out: string[] = [];
  for (const c of clients) {
    const nameTokens = tokens(c.full_name);
    if (nameTokens.length >= 2 && nameTokens.every((t) => eventTokens.has(t))) {
      out.push(c.id);
    }
  }
  return out;
}

/**
 * All suggestion candidates for a queued session (issue #83): learned
 * aliases first (they encode a past human confirmation), then full-name
 * hits, deduped preserving that order.
 */
export function allCandidatesFor(
  session: UnmatchedSession,
  aliases: AliasLite[],
  clients: { id: string; full_name: string }[],
): string[] {
  return Array.from(
    new Set([
      ...candidatesFor(session, aliases),
      ...nameCandidatesFor(session, clients),
    ]),
  );
}

/**
 * Options for the client autocomplete (issue #80). Suggested (ambiguous-
 * alias) candidates always rank first; an empty query shows ONLY them —
 * typing searches the whole book by name or phone with the same
 * `matchesQuery` semantics as the Clientas screen. Capped for the shop
 * phone's screen; `hidden` is how many matches the cap cut off.
 */
export function filterClientOptions<T extends PickableClient>(
  candidates: T[],
  clients: T[],
  query: string,
  cap: number,
): { visible: T[]; hidden: number } {
  const q = query.trim();
  const candidateIds = new Set(candidates.map((c) => c.id));
  const rest = clients.filter((c) => !candidateIds.has(c.id));
  const pool = q === ""
    ? candidates
    : [...candidates, ...rest].filter((c) => matchesQuery(c, q));
  return {
    visible: pool.slice(0, cap),
    hidden: Math.max(0, pool.length - cap),
  };
}

/**
 * Whether a queued session is still ahead of us (issue #95): strictly
 * time-based — a session earlier today is already past its reminder window
 * and belongs to the backlog, not to the before-16:00 urgency list.
 */
export function isUpcoming(startsAtIso: string, nowMs: number): boolean {
  return new Date(startsAtIso).getTime() >= nowMs;
}

/**
 * Whether learning `rawAlias` for `clientId` would split an existing alias
 * across two clients (§7.3, schema invariant "an alias cannot point to two
 * clients"). `existingClientId` is the current owner of that raw_alias, or
 * null if none. True → the resolution must be refused.
 */
export function aliasConflictsWith(
  existingClientId: string | null,
  clientId: string,
): boolean {
  return existingClientId !== null && existingClientId !== clientId;
}

// The conflict/reuse/create decision moved to its natural home,
// lib/clients/upsert.ts (it belongs with the shared findOrCreateClient, not
// the unmatched queue). Re-exported here so existing importers/tests keep
// working through one definition.
export { newClientDecision } from "../clients/upsert";

/**
 * Retroactive re-match (§7.3): given the alias tokens learned from a manual
 * resolution, return the still-queued sessions the new alias now resolves.
 * The just-resolved session is excluded (it's handled directly). This is
 * what makes "resolving one event matches another with the same alias" work.
 */
export function retroactiveMatches(
  newAliasTokens: string[],
  resolvedSessionId: string,
  queued: UnmatchedSession[],
): string[] {
  if (newAliasTokens.length === 0) return [];
  return queued
    .filter((s) => s.id !== resolvedSessionId)
    .filter((s) => aliasMatches(newAliasTokens, sessionTokens(s)))
    .map((s) => s.id);
}

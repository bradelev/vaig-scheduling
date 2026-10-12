/**
 * Orchestration for sync-calendar (PRD FR-1, issue E2-T3), decoupled from
 * I/O through `Deps` so the whole pipeline is testable with fakes:
 * classify (§7.0) → upsert → reschedule reset → match cascade (§7.2) →
 * learn aliases → job_runs audit.
 */
import {
  classify,
  type ClientLite,
  extractPhones,
  matchableText,
  matchEvent,
  type RawEvent,
  redactPhones,
  tokens,
} from "./logic.ts";

export type UpsertRow = {
  gcal_event_id: string;
  starts_at: string;
  ends_at: string | null;
  raw_title: string;
  raw_description: string | null;
  source: "external" | "manual";
  // "reschedule_requested" is never produced by classification — it only
  // appears here when the preservation pass (issue #64) carries an existing
  // row's webhook-set state through the hourly upsert.
  status: "scheduled" | "cancelled" | "reschedule_requested";
};

/** A cancelled tombstone with no start: only flips status on an existing row. */
export type CancelRow = { gcal_event_id: string };

export type ExistingSession = {
  gcal_event_id: string;
  starts_at: string;
  reminder_sent_at: string | null;
  status: string;
};

/**
 * Timestamp equality by INSTANT, not by string (issue #64): Google emits
 * calendar-local offsets ("…T18:30:00-03:00") while PostgREST re-emits UTC
 * ("…T21:30:00+00:00"). Comparing strings branded every unmoved session
 * with a sent reminder as "rescheduled" on the next hourly sync — wiping
 * reminder marks AND confirmations one hour after they happened.
 */
const sameInstant = (a: string, b: string): boolean =>
  new Date(a).getTime() === new Date(b).getTime();

export type SessionToMatch = {
  id: string;
  gcal_event_id: string;
  raw_title: string;
  raw_description: string | null;
  source: string;
};

export type AliasRow = { client_id: string; alias_tokens: string[] };

export type NewAlias = {
  client_id: string;
  raw_alias: string;
  alias_tokens: string[];
};

export interface Deps {
  now(): Date;
  /** Calendar events inside the sync window (already single-expanded). */
  fetchEvents(timeMin: string, timeMax: string): Promise<RawEvent[]>;
  /** Existing rows for these gcal ids, to detect reschedules. */
  fetchExisting(gcalIds: string[]): Promise<ExistingSession[]>;
  /** Upsert by gcal_event_id (creates or updates starts/title/desc/status). */
  upsertSessions(rows: UpsertRow[]): Promise<void>;
  /** Mark existing rows cancelled (tombstones with no start to upsert). */
  cancelExisting(gcalIds: string[]): Promise<void>;
  /** Reset reminder state on a reschedule (§FR-1). */
  resetReminder(gcalIds: string[]): Promise<void>;
  /** Unmatched sessions in the window to run the cascade over. */
  fetchUnmatched(): Promise<SessionToMatch[]>;
  /** All clients (id, phone) — the shop has ~1.3k, one page is fine. */
  fetchClients(): Promise<ClientLite[]>;
  /** All aliases (client_id, tokens) for the subset match. */
  fetchAliases(): Promise<AliasRow[]>;
  /** Persist a resolved match on a session. */
  applyMatch(
    sessionId: string,
    clientId: string,
    method: "phone" | "alias",
  ): Promise<void>;
  /** Insert learned aliases, skipping on unique conflict (§7.2.1 bonus). */
  insertAliases(rows: NewAlias[]): Promise<void>;
  /**
   * Self-heal for the queue (issue #84): dismiss leftover UNMATCHED rows of
   * events the classifier now discards — rows ingested before a §7.0
   * pattern existed would otherwise sit in the queue forever. Returns how
   * many rows were dismissed. Matched rows are never touched.
   */
  dismissDiscarded(gcalIds: string[]): Promise<number>;
  startJobRun(): Promise<string>;
  finishJobRun(id: string, ok: boolean, detail: unknown): Promise<void>;
}

const DAY_MS = 86_400_000;

export type RunOptions = { backfillDays?: number };

export async function runSync(
  deps: Deps,
  opts: RunOptions = {},
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  const jobId = await deps.startJobRun();
  const detail: Record<string, unknown> = {};
  try {
    const now = deps.now().getTime();
    const back = opts.backfillDays ?? 7; // FR-1: today−7 by default, 90 for backfill.
    const timeMin = new Date(now - back * DAY_MS).toISOString();
    const timeMax = new Date(now + 45 * DAY_MS).toISOString();
    const events = await deps.fetchEvents(timeMin, timeMax);

    // §7.0 classification, before anything else.
    const discards: { reason: string; count: number; sample: string[] } = {
      reason: "mixed",
      count: 0,
      sample: [],
    };
    const discardByReason: Record<string, string[]> = {};
    const discardIds: string[] = [];
    const upserts: UpsertRow[] = [];
    // Cancelled tombstones without a start: can only flip an existing row.
    const cancelOnly: string[] = [];
    for (const ev of events) {
      const c = classify(ev);
      if (c.kind === "discard") {
        (discardByReason[c.reason] ??= []).push(c.summary);
        discardIds.push(c.id);
        continue;
      }
      if (c.starts_at === null) {
        cancelOnly.push(c.id);
        continue;
      }
      upserts.push({
        gcal_event_id: c.id,
        starts_at: c.starts_at,
        ends_at: c.ends_at,
        raw_title: c.raw_title,
        raw_description: c.raw_description,
        source: c.source,
        status: c.status,
      });
    }
    discards.count = Object.values(discardByReason).reduce(
      (n, arr) => n + arr.length,
      0,
    );
    // Audit: counts per reason + a small redacted sample (§7.0 audit).
    detail.discarded = Object.fromEntries(
      Object.entries(discardByReason).map(([reason, titles]) => [
        reason,
        { count: titles.length, sample: titles.slice(0, 3).map(redactPhones) },
      ]),
    );

    // Self-heal (issue #84): rows ingested before a discard pattern existed
    // linger in the queue forever, because classification only gates NEW
    // upserts. Dismissing them here makes pattern additions retroactive on
    // every sync; matched rows (a human or the cascade confirmed a client)
    // are never touched by contract.
    detail.retro_dismissed = discardIds.length
      ? await deps.dismissDiscarded(discardIds)
      : 0;

    // Reschedule detection: an existing row whose starts_at changed AND had
    // a reminder sent → reset (new date ⇒ new reminder) (FR-1).
    const existing = new Map(
      (await deps.fetchExisting(upserts.map((u) => u.gcal_event_id))).map((
        e,
      ) => [e.gcal_event_id, e]),
    );
    const toReset = upserts
      .filter((u) => {
        const prev = existing.get(u.gcal_event_id);
        return prev && prev.reminder_sent_at !== null &&
          !sameInstant(prev.starts_at, u.starts_at);
      })
      .map((u) => u.gcal_event_id);

    // The hourly upsert must not clobber webhook/operator state (issue #64):
    // an unmoved event whose row says reschedule_requested keeps it — the
    // calendar has no opinion between "active" states. A REAL move returns
    // the row to "scheduled" (fresh reminder cycle; toReset above clears the
    // marks), and "cancelled" from the calendar always wins.
    for (const u of upserts) {
      const prev = existing.get(u.gcal_event_id);
      if (
        prev?.status === "reschedule_requested" &&
        u.status === "scheduled" &&
        sameInstant(prev.starts_at, u.starts_at)
      ) {
        u.status = "reschedule_requested";
      }
    }

    const created = upserts.filter((u) => !existing.has(u.gcal_event_id)).length;
    const updated = upserts.length - created;

    await deps.upsertSessions(upserts);
    if (cancelOnly.length) await deps.cancelExisting(cancelOnly);
    if (toReset.length) await deps.resetReminder(toReset);

    // §7.2 cascade over every still-unmatched session in the window.
    const unmatched = await deps.fetchUnmatched();
    const clientsByPhone = new Map(
      (await deps.fetchClients()).map((c) => [c.phone, c.id]),
    );
    // Aliases are re-read once; learned aliases within this run also feed
    // later events so the cascade is retroactive within a single sync.
    const aliases = await deps.fetchAliases();
    const learned: NewAlias[] = [];
    const seenAlias = new Set(aliases.map((a) => a.alias_tokens.join(" ")));
    let matchedPhone = 0;
    let matchedAlias = 0;
    let queued = 0;

    for (const s of unmatched) {
      const text = matchableText(s.source, s.raw_title);
      const eventTokens = tokens(text);
      const phones = extractPhones(s.raw_title, s.raw_description);
      const result = matchEvent({ phones, eventTokens }, clientsByPhone, aliases);

      if (result.method === "phone") {
        await deps.applyMatch(s.id, result.client_id, "phone");
        matchedPhone++;
        if (result.learnAlias) {
          const key = result.learnAlias.join(" ");
          if (!seenAlias.has(key)) {
            seenAlias.add(key);
            const newAlias: NewAlias = {
              client_id: result.client_id,
              // Normalized token string — never the raw title, which for a
              // External event carries the full phone number (r3). Keeps
              // raw_alias phone-free and aligned with the dedup key.
              raw_alias: key,
              alias_tokens: result.learnAlias,
            };
            learned.push(newAlias);
            aliases.push({
              client_id: result.client_id,
              alias_tokens: result.learnAlias,
            });
          }
        }
      } else if (result.method === "alias") {
        await deps.applyMatch(s.id, result.client_id, "alias");
        matchedAlias++;
      } else {
        queued++;
      }
    }

    if (learned.length) await deps.insertAliases(learned);

    detail.seen = events.length;
    detail.created = created;
    detail.updated = updated;
    detail.rescheduled = toReset.length;
    detail.matched = { phone: matchedPhone, alias: matchedAlias };
    detail.queued = queued;
    detail.aliases_learned = learned.length;

    await deps.finishJobRun(jobId, true, detail);
    return { ok: true, detail };
  } catch (err) {
    detail.fatal = redactPhones(String(err));
    await deps.finishJobRun(jobId, false, detail);
    return { ok: false, detail };
  }
}

/**
 * Pure logic for send-review-requests (PRD §III, layer 3). No I/O — everything
 * here is unit-testable under `deno test`. Twin of send-reminders/logic.ts but
 * for the Google review ask: the day AFTER a session, to loyal clients (3+
 * completed sessions) who never reviewed, once, from the bot number.
 *
 * Node has a twin copy in lib/reviews (the manual wa.me path); this Deno copy
 * is what the automated template send uses. The customer-facing body MUST match
 * the approved template `pedido_resena` and the Node copy — kept in sync by
 * hand (twin-equality is a known cross-runtime constraint).
 */

export const TIMEZONE = "America/Montevideo";

/** The approved WhatsApp template (MARKETING, es_UY). Its URL button carries
 *  the Google link statically, so the send payload never sets a button param. */
export const REVIEW_TEMPLATE = "pedido_resena";

export type ReviewCandidate = {
  client_id: string;
  full_name: string;
  phone: string; // E.164 (+598...)
  last_completed_at: string; // ISO — the session that triggers the ask
};

/** Calendar day of a timestamp in Montevideo, as YYYY-MM-DD (en-CA format). */
export function localDayKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

const HOUR_MS = 3_600_000;

/**
 * Half-open UTC window covering YESTERDAY's whole Montevideo calendar day,
 * [yesterday 00:00, today 00:00) local. The review batch runs once a day and
 * asks clients whose last completed session was yesterday — "the day after the
 * session". Uruguay has no DST, so the fixed -03:00 offset is exact year-round
 * and subtracting 24h from a local midnight always lands on the previous local
 * midnight.
 */
export function yesterdayLocalDayWindow(
  now: Date,
): { fromIso: string; toIso: string } {
  const todayMidnight = new Date(
    `${localDayKey(now.toISOString())}T00:00:00-03:00`,
  );
  return {
    fromIso: new Date(todayMidnight.getTime() - 24 * HOUR_MS).toISOString(),
    toIso: todayMidnight.toISOString(),
  };
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? "";
}

/** Graph API wants the number without the leading +. */
export function waPhone(e164: string): string {
  return e164.replace(/^\+/, "");
}

/** Only the last 4 digits ever reach logs (CLAUDE.md sensitive-data rule). */
export function phoneLast4(phone: string): string {
  return phone.slice(-4);
}

/** Redacts any 7+ digit run down to its last 4 (Graph errors echo the number). */
export function redactPhones(text: string): string {
  return text.replace(/\d{7,}/g, (m) => `***${m.slice(-4)}`);
}

/**
 * At most one review ask per client per batch. The DB predicate already
 * guarantees one candidate row per client (v_review_candidates is one row per
 * client), but a defensive dedup keeps a duplicated row from double-sending.
 */
export function dedupeByClient(
  candidates: ReviewCandidate[],
): { toSend: ReviewCandidate[]; skipped: { client_id: string }[] } {
  const seen = new Set<string>();
  const toSend: ReviewCandidate[] = [];
  const skipped: { client_id: string }[] = [];
  for (const c of candidates) {
    if (seen.has(c.client_id)) {
      skipped.push({ client_id: c.client_id });
    } else {
      seen.add(c.client_id);
      toSend.push(c);
    }
  }
  return { toSend, skipped };
}

/**
 * Review-request template payload (`pedido_resena`, es_UY). Only the body's
 * {{1}} = first name is set; the Google link lives in the template's static URL
 * button, so no button component is sent (Meta fills it from the template).
 * `overrideTo` (rehearsal, issue #60) replaces ONLY the destination.
 */
export function buildReviewPayload(
  c: ReviewCandidate,
  overrideTo?: string,
): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    to: waPhone(overrideTo ?? c.phone),
    type: "template",
    template: {
      name: REVIEW_TEMPLATE,
      language: { code: "es_UY" },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: firstName(c.full_name) }],
        },
      ],
    },
  };
}

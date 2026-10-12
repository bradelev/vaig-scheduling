/**
 * Pure logic for calendar-write (PRD Part II §II.7, issue #118): building the
 * Google Calendar mirror-event payload and the deterministic event id. No
 * network, no Deno APIs beyond crypto — unit-testable against fixtures.
 *
 * The app is the source of truth for app-origin sessions; the calendar event
 * is a MIRROR. Two invariants make the write safe:
 *   1. Idempotency — the event id is derived deterministically from the
 *      session id, so a retried create is a no-op/update, never a duplicate.
 *   2. Ownership marker — every mirror event carries an extended property
 *      `extendedProperties.private.vaigApp = "1"` (+ the session id), so the
 *      hourly sync can skip its own events as a session source while still
 *      routing external/manual events through the matching cascade.
 */

export const APP_MARKER_KEY = "vaigApp";
export const APP_MARKER_VALUE = "1";
export const SESSION_ID_KEY = "vaigSessionId";

/** A session as this function needs it (the fields that shape the event). */
export type MirrorSession = {
  id: string;
  starts_at: string; // ISO
  ends_at: string | null; // ISO or null
  client_name: string;
  service: string | null; // service_types slug (category), optional
  /** Google Calendar colorId (1–11) for the attending employee; null = default
   *  color. Resolved in the Node server action from the staff catalog and
   *  passed across the runtime boundary as a plain number. */
  color_id?: number | null;
};

export type CalendarEvent = {
  id: string;
  summary: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  extendedProperties: { private: Record<string, string> };
  colorId?: string; // Google wants colorId as a string ("1".."11")
};

/** Visible marker prefix on app-created events (feature 2026-08-16): a 📌 so
 *  the team distinguishes VAIG-app events from External/manual at a glance.
 *  Overrides the original "clean title" design (PRD updated same day). */
export const MIRROR_TITLE_PREFIX = "📌 ";

export const TIMEZONE = "America/Montevideo";
/** Default mirror duration when a session has no ends_at (minutes). */
export const DEFAULT_DURATION_MINUTES = 60;

/**
 * Deterministic Google Calendar event id from a session UUID. Google requires
 * event ids to be base32hex (chars a-v and 0-9), length 5–1024, lowercase.
 * A UUID's hex digits are already a subset of that alphabet once hyphens are
 * stripped, so a stable prefix + the hyphen-free lowercased UUID is valid and
 * one-to-one with the session — making create idempotent (same session id →
 * same event id → PATCH on retry, never a second event).
 */
export function eventIdForSession(sessionId: string): string {
  const hex = sessionId.replace(/-/g, "").toLowerCase();
  if (!/^[a-v0-9]+$/.test(hex) || hex.length < 3) {
    throw new Error(`session id is not a valid uuid hex: ${sessionId}`);
  }
  return `vaig${hex}`;
}

/**
 * Event title: "📌 Nombre — Categoría" (or "📌 Nombre" without a service). The
 * 📌 prefix is a VISIBLE app marker (feature 2026-08-16, Braulio) so the team
 * spots VAIG-app events like they spot "External - …" — a deliberate change from
 * the original "clean title" rule (PRD updated). The invisible ownership marker
 * still lives in extendedProperties (used by isAppManaged); the emoji is for humans.
 */
export function mirrorSummary(session: MirrorSession): string {
  const name = session.client_name.trim();
  const svc = session.service?.trim();
  const body = svc ? `${name} — ${svc}` : name;
  return `${MIRROR_TITLE_PREFIX}${body}`;
}

/** End time: the session's ends_at, or starts_at + default duration. */
export function mirrorEnd(session: MirrorSession): string {
  if (session.ends_at) return session.ends_at;
  const start = new Date(session.starts_at);
  return new Date(
    start.getTime() + DEFAULT_DURATION_MINUTES * 60_000,
  ).toISOString();
}

/** The full event body Google expects for create (PUT with client id) / patch. */
export function buildMirrorEvent(session: MirrorSession): CalendarEvent {
  const event: CalendarEvent = {
    id: eventIdForSession(session.id),
    summary: mirrorSummary(session),
    start: { dateTime: session.starts_at, timeZone: TIMEZONE },
    end: { dateTime: mirrorEnd(session), timeZone: TIMEZONE },
    extendedProperties: {
      private: {
        [APP_MARKER_KEY]: APP_MARKER_VALUE,
        [SESSION_ID_KEY]: session.id,
      },
    },
  };
  // Per-employee color (feature 2026-08-16). Only a valid 1–11 colorId is sent;
  // null/out-of-range → omit the field so the event keeps the default color.
  if (
    typeof session.color_id === "number" &&
    Number.isInteger(session.color_id) &&
    session.color_id >= 1 &&
    session.color_id <= 11
  ) {
    event.colorId = String(session.color_id);
  }
  return event;
}

/** True when a fetched calendar event is one this app created (skip in sync). */
export function isAppManaged(ev: {
  extendedProperties?: { private?: Record<string, string> };
}): boolean {
  return ev.extendedProperties?.private?.[APP_MARKER_KEY] === APP_MARKER_VALUE;
}

/**
 * Google Calendar I/O for calendar-write (#118), separated from the serve
 * handler (index.ts) so the HTTP contract can be unit-tested with a mocked
 * `fetch` — the layer where the insert-vs-update semantics live and where a
 * wrong assumption (PUT does not create) went undetected before.
 */
import { buildMirrorEvent, eventIdForSession, type MirrorSession } from "./logic.ts";

function eventsUrl(calendarId: string): string {
  return `https://www.googleapis.com/calendar/v3/calendars/${
    encodeURIComponent(calendarId)
  }/events`;
}
function eventUrl(calendarId: string, eventId: string): string {
  return `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`;
}

/**
 * Create-or-update the mirror event, idempotently. Google only allows a
 * client-specified event id on events.INSERT (POST); events.update (PUT)
 * requires the event to already exist. So a create tries POST first, and a
 * 409 ("already exists" — a retry) falls back to PUT. Same session id → same
 * deterministic event id → never a duplicate. Returns the event id.
 */
export async function upsertMirror(
  token: string,
  calendarId: string,
  session: MirrorSession,
  op: "create" | "update",
): Promise<string> {
  const event = buildMirrorEvent(session);
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  if (op === "create") {
    const res = await fetch(eventsUrl(calendarId), {
      method: "POST",
      headers,
      body: JSON.stringify(event),
    });
    if (res.ok) return event.id;
    if (res.status !== 409) {
      const body = await res.text();
      throw new Error(`calendar insert: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    // 409 → the deterministic id already exists (retried create): update it.
  }

  const res = await fetch(eventUrl(calendarId, event.id), {
    method: "PUT",
    headers,
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`calendar update: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return event.id;
}

/** Delete the mirror event; 404/410 (already gone) counts as success. */
export async function deleteMirror(
  token: string,
  calendarId: string,
  sessionId: string,
): Promise<void> {
  const id = eventIdForSession(sessionId);
  const res = await fetch(eventUrl(calendarId, id), {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.ok || res.status === 404 || res.status === 410) return;
  const body = await res.text();
  throw new Error(`calendar delete: HTTP ${res.status} ${body.slice(0, 200)}`);
}

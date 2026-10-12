"use server";

/**
 * Server Actions for the app-origin session CRUD (PRD Part II §II.2, issue
 * #116, task v3-T2.1). These MUTATE production: create/edit/move/cancel
 * sessions with source='app'. Runs server-side with the service role — the
 * browser never sees the key. Never touches the calendar (that's T3.1) and
 * never touches external/manual rows (guarded by `.eq("source", "app")`).
 */
import { revalidatePath } from "next/cache";
import { serviceClient } from "../supabase/service";
import { findOrCreateClient } from "../clients/upsert";
import { mirrorDelete, mirrorUpsert } from "./mirror";
import { notifyReservationConfirmed } from "../booking/notify-client";
import { PLACEHOLDER_CLIENT_NAME } from "../booking/reserve";
import { requireStaff } from "../auth/require-staff";
import { needsImmediateReminder, sendImmediateReminder } from "./immediate-reminder";
import { isKnownStaff, staffColorId } from "./staff";

const DEFAULT_DURATION_MINUTES = 60;

/**
 * Validate a service category against the `service_types` catalog before it
 * reaches the DB, so an unknown value returns a clean Spanish error instead
 * of leaking the raw Postgres trigger message. Returns an error string, or
 * null when the value is acceptable (null/absent is always fine).
 */
async function invalidServiceError(
  db: ReturnType<typeof serviceClient>,
  service: string | null | undefined,
): Promise<string | null> {
  if (service === null || service === undefined || service === "") return null;
  const { data, error } = await db
    .from("service_types")
    .select("slug")
    .eq("slug", service)
    .maybeSingle();
  if (error) return `No se pudo verificar el servicio: ${error.message}`;
  if (!data) return `El servicio "${service}" no es una categoría válida.`;
  return null;
}

/**
 * Create an app-origin session, either for an existing client (`clientId`)
 * or a brand-new one created inline (`newClient`). Exactly one of the two
 * must be provided. `gcal_event_id` is left NULL — the mirror event is
 * written later (T3.1); a NULL gcal on an app row means "mirror pending".
 */
export async function createSession(input: {
  clientId?: string;
  newClient?: { fullName: string; phone: string; isFirstVisit: boolean };
  startsAt: string;
  durationMinutes?: number;
  service?: string;
  note?: string;
  /** Attending employee id (staff catalog) → the mirror event's color. */
  attendedBy?: string;
}): Promise<
  { sessionId: string; mirrored: boolean } | { error: string }
> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const hasClientId = !!input.clientId;
  const hasNewClient = !!input.newClient;
  if (hasClientId === hasNewClient) {
    return { error: "Falta la clienta." };
  }

  if (!input.startsAt) {
    return { error: "Falta la fecha y hora de inicio." };
  }
  if (Number.isNaN(new Date(input.startsAt).getTime())) {
    return { error: "La fecha y hora no es válida." };
  }

  const db = serviceClient();

  // Resolve the client through the single findOrCreateClient path (phone
  // uniqueness, conflict/reuse/create, is_first_visit-on-create all live there).
  let clientId: string;
  if (input.newClient) {
    const resolved = await findOrCreateClient(db, {
      fullName: input.newClient.fullName,
      phone: input.newClient.phone,
      isFirstVisit: input.newClient.isFirstVisit,
    });
    if ("error" in resolved) return { error: resolved.error };
    clientId = resolved.clientId;
  } else {
    clientId = input.clientId!;
  }

  const serviceErr = await invalidServiceError(db, input.service);
  if (serviceErr) return { error: serviceErr };

  const startsAt = new Date(input.startsAt);
  const durationMinutes = input.durationMinutes ?? DEFAULT_DURATION_MINUTES;
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

  // Only store a KNOWN staff id; anything else (or "sin asignar") → null, so a
  // stale/tampered value can't poison the row or the color lookup.
  const attendedBy =
    input.attendedBy && (await isKnownStaff(db, input.attendedBy))
      ? input.attendedBy
      : null;

  const { data: created, error: insErr } = await db
    .from("sessions")
    .insert({
      source: "app",
      client_id: clientId,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      service: input.service ?? null,
      note: input.note ?? null,
      status: "scheduled",
      attended_by: attendedBy,
      gcal_event_id: null,
    })
    .select("id")
    .single();
  if (insErr) {
    return { error: `No se pudo crear la sesión: ${insErr.message}` };
  }

  // Best-effort mirror to Google Calendar (#118). A failure here never fails
  // the create — the session exists with gcal NULL ("mirror pending") — but we
  // now REPORT it so the UI can warn the operator instead of a silent "creada".
  const mirrored = await mirrorSession(db, created.id, "create");

  // Immediate reminder (#120): a session for tomorrow created after today's
  // 16:00 batch would otherwise never remind. Best-effort; the batch backstops.
  if (needsImmediateReminder(startsAt.toISOString(), new Date())) {
    await sendImmediateReminder(created.id);
  }

  revalidatePath("/");
  return { sessionId: created.id, mirrored };
}

/**
 * Write/refresh the Google Calendar mirror for an app session and store the
 * returned event id (#118). Best-effort: on any failure the session keeps
 * gcal_event_id NULL and is retried later. Reads the client name (the event
 * title needs it) and the session times fresh from the DB.
 */
async function mirrorSession(
  db: ReturnType<typeof serviceClient>,
  sessionId: string,
  op: "create" | "update",
): Promise<boolean> {
  const { data: row } = await db
    .from("sessions")
    .select(
      "id, starts_at, ends_at, service, attended_by, pending_confirmation, clients(full_name)",
    )
    .eq("id", sessionId)
    .maybeSingle();
  if (!row) return false;
  // A public reservation still awaiting STAFF confirmation is not on the
  // calendar yet (migration pending_confirmation): an edit/move from the
  // agenda must not mirror it. Confirming it is what creates the event.
  if (row.pending_confirmation === true) return false;
  const clientName =
    (row.clients as { full_name?: string } | null)?.full_name ?? "";
  const result = await mirrorUpsert(
    {
      id: row.id,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      client_name: clientName,
      service: row.service ?? null,
      // Per-employee calendar color: resolve the attending staff's colorId here
      // (Node) and pass the number to the Deno calendar-write function.
      color_id: await staffColorId(db, row.attended_by),
    },
    op,
  );
  if (!result.ok) return false;
  if (result.ok && result.eventId) {
    const { error: patchErr } = await db
      .from("sessions")
      .update({ gcal_event_id: result.eventId })
      .eq("id", sessionId)
      .eq("source", "app");
    // The Google event exists but we failed to link it back. Surface it: the
    // row is silently orphaned otherwise (gcal NULL but the event is real). A
    // retried create is safe — it 409s and updates the same deterministic id.
    if (patchErr) {
      console.error(
        `mirror: event created but gcal_event_id patch failed for session ${sessionId}: ${patchErr.message}`,
      );
    }
  }
  // "mirrored" reflects what the operator sees: the calendar event was written
  // (result.ok). A failed gcal_event_id patch-back is an internal linking issue
  // logged above — the event IS on the calendar, so it's not a mirror failure.
  return true;
}

/**
 * Edit an app-origin session's service/note/client. Only the provided
 * fields are updated. Guarded to source='app' so it can never touch
 * external/manual rows.
 */
export async function editSession(input: {
  sessionId: string;
  service?: string;
  note?: string;
  clientId?: string;
}): Promise<{ ok: true } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const db = serviceClient();

  // An empty-string service means "clear it" → store NULL (the trigger only
  // validates non-null app services; NULL is always allowed).
  const service =
    input.service === "" ? null : input.service;
  const serviceErr = await invalidServiceError(db, service);
  if (serviceErr) return { error: serviceErr };

  const patch: Record<string, unknown> = {};
  if (input.service !== undefined) patch.service = service;
  if (input.note !== undefined) patch.note = input.note;
  if (input.clientId !== undefined) patch.client_id = input.clientId;

  const { data: updated, error } = await db
    .from("sessions")
    .update(patch)
    .eq("id", input.sessionId)
    .eq("source", "app")
    // A cancelled session is read-only: never re-edit one (stale-tab race).
    .neq("status", "cancelled")
    .select("id");
  if (error) {
    return { error: `No se pudo editar la sesión: ${error.message}` };
  }
  if (!updated || updated.length === 0) {
    return { error: "No se encontró la sesión." };
  }

  // Service/client edits change the mirror event's title → refresh it.
  await mirrorSession(db, input.sessionId, "update");

  revalidatePath("/");
  return { ok: true };
}

/**
 * Move an app-origin session to a new start time, preserving its existing
 * duration (recomputes ends_at from the delta between the current
 * starts_at/ends_at). If ends_at was null, it stays null. Guarded to
 * source='app'.
 */
export async function moveSession(input: {
  sessionId: string;
  startsAt: string;
}): Promise<{ ok: true } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  if (!input.startsAt || Number.isNaN(new Date(input.startsAt).getTime())) {
    return { error: "La fecha y hora no es válida." };
  }

  const db = serviceClient();

  const { data: current, error: readErr } = await db
    .from("sessions")
    .select("starts_at, ends_at, pending_confirmation")
    .eq("id", input.sessionId)
    .eq("source", "app")
    .maybeSingle();
  if (readErr) {
    return { error: `No se pudo leer la sesión: ${readErr.message}` };
  }
  if (!current) {
    return { error: "No se encontró la sesión." };
  }

  const newStartsAt = new Date(input.startsAt);
  let newEndsAt: Date | null = null;
  if (current.ends_at) {
    const durationMs =
      new Date(current.ends_at).getTime() - new Date(current.starts_at).getTime();
    newEndsAt = new Date(newStartsAt.getTime() + durationMs);
  }

  const patch: Record<string, unknown> = {
    starts_at: newStartsAt.toISOString(),
    ends_at: newEndsAt ? newEndsAt.toISOString() : null,
  };
  // A REAL date change is a new appointment time: clear reminder/confirmation
  // state so send-reminders re-reminds for the new date (mirrors the sync's
  // resetReminder, PRD FR-1). Compared by INSTANT, not string — a move to the
  // same instant (a no-op) must NOT wipe an already-sent reminder.
  const moved =
    new Date(current.starts_at).getTime() !== newStartsAt.getTime();
  if (moved) {
    patch.reminder_sent_at = null;
    patch.reminder_wamid = null;
    patch.confirmed_at = null;
  }

  const { error: updErr } = await db
    .from("sessions")
    .update(patch)
    .eq("id", input.sessionId)
    .eq("source", "app")
    // A cancelled session is read-only: never move one (stale-tab race).
    .neq("status", "cancelled");
  if (updErr) {
    return { error: `No se pudo mover la sesión: ${updErr.message}` };
  }

  // Reflect the new time on the mirror event.
  await mirrorSession(db, input.sessionId, "update");

  // Moving INTO tomorrow after 16:00 falls in the same 24h hole as a late
  // create (#120). A real move cleared reminder_sent_at above, so the session
  // is eligible again; fire immediately if the batch would miss it.
  // A public reservation still awaiting staff confirmation is never reminded
  // (send-reminders excludes it) — firing here would only log "0 sent".
  // confirmReservation sends the immediate reminder when the team confirms.
  if (
    moved &&
    current.pending_confirmation !== true &&
    needsImmediateReminder(newStartsAt.toISOString(), new Date())
  ) {
    await sendImmediateReminder(input.sessionId);
  }

  revalidatePath("/");
  return { ok: true };
}

/**
 * Cancel an app-origin session. Guarded to source='app'.
 */
export async function cancelSession(input: {
  sessionId: string;
}): Promise<{ ok: true } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const db = serviceClient();

  const { data: updated, error } = await db
    .from("sessions")
    .update({ status: "cancelled" })
    .eq("id", input.sessionId)
    .eq("source", "app")
    // Idempotent: already-cancelled is a no-op (stale-tab race → "not found").
    .neq("status", "cancelled")
    .select("id");
  if (error) {
    return { error: `No se pudo cancelar la sesión: ${error.message}` };
  }
  if (!updated || updated.length === 0) {
    return { error: "No se encontró la sesión." };
  }

  // Remove the mirror event from the calendar (best-effort; already-gone ok).
  await mirrorDelete(input.sessionId);
  // Cuponera refund for a FUTURE session happens in the DB — the
  // sessions_refund_package_credit trigger fires on the scheduled→cancelled
  // transition for EVERY path (this action, sync-calendar tombstones, SQL),
  // so nothing here may refund too or the credit would come back twice.

  revalidatePath("/");
  return { ok: true };
}

/**
 * Remove a MATCHED calendar-origin session (source manual/external) from the app
 * by stamping dismissed_at — the sync respects it forever (issue #84), so a
 * dismissed row never comes back. For the orphan case where the calendar event
 * was deleted but its DB row lingered (an identified, non-app session with no
 * exit): cancelSession can't touch it (source≠'app'), and the calendar can't fix it
 * (the event is gone). We do NOT call the calendar — an app-side dismiss must
 * never delete a still-live calendar event we don't own.
 *
 * Guarded to source≠'app' (app sessions use cancelSession, which also removes
 * the mirror). Whether the session is matched or not, dismissing is safe.
 */
export async function dismissMatchedSession(input: {
  sessionId: string;
}): Promise<{ ok: true } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const db = serviceClient();
  const { data: updated, error } = await db
    .from("sessions")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", input.sessionId)
    .neq("source", "app")
    .is("dismissed_at", null) // idempotent: already-dismissed → "not found"
    .select("id");
  if (error) {
    return { error: `No se pudo quitar la sesión: ${error.message}` };
  }
  if (!updated || updated.length === 0) {
    return { error: "No se encontró la sesión." };
  }
  revalidatePath("/");
  return { ok: true };
}

/**
 * A public reservation (source='app', pending_confirmation) as returned by the
 * confirm update — with the client and the catalog item embedded for the
 * client-facing confirmation notice.
 */
type ConfirmedRow = {
  id: string;
  starts_at: string;
  clients:
    | { full_name: string; phone: string | null; opted_out: boolean }
    | { full_name: string; phone: string | null; opted_out: boolean }[]
    | null;
  booking_services: { name: string; category: string | null } | { name: string; category: string | null }[] | null;
};

function embedded<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/**
 * Staff confirm a public reservation ("por confirmar" → firm appointment,
 * the internal booking plan §"Reservas por confirmar"). Clears
 * pending_confirmation (guarded: app-origin, still pending, still scheduled),
 * then — best-effort, in this order — creates the Google Calendar mirror
 * event, sends the immediate reminder if the batch already ran (#120), and
 * tells the client via the reserva_confirmada template unless they opted out.
 * None of the best-effort steps can undo the confirmation.
 */
export async function confirmReservation(input: {
  sessionId: string;
}): Promise<{ ok: true; mirrored: boolean } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const db = serviceClient();

  const { data: updated, error } = await db
    .from("sessions")
    .update({ pending_confirmation: false })
    .eq("id", input.sessionId)
    .eq("source", "app")
    .eq("pending_confirmation", true)
    // A cancelled (or otherwise non-scheduled) reservation can't be confirmed.
    .eq("status", "scheduled")
    .select(
      "id, starts_at, clients(full_name, phone, opted_out), booking_services(name, category)",
    );
  if (error) {
    return { error: `No se pudo confirmar la reserva: ${error.message}` };
  }
  if (!updated || updated.length === 0) {
    return { error: "No se encontró la reserva." };
  }
  const row = updated[0] as ConfirmedRow;

  // Now it's a firm appointment: put it on the calendar (first time — the
  // pending row was never mirrored).
  const mirrored = await mirrorSession(db, input.sessionId, "create");

  // Tell the client FIRST — before any reminder, so their WhatsApp reads
  // "quedó confirmada" and then "te recordamos", never the reverse.
  // Best-effort: the template may still be in Meta review, the phone may be
  // missing — the confirmation stands regardless.
  const client = embedded(row.clients);
  const item = embedded(row.booking_services);
  if (client?.phone && !client.opted_out) {
    try {
      await notifyReservationConfirmed({
        clientPhone: client.phone,
        clientName: client.full_name === PLACEHOLDER_CLIENT_NAME ? null : client.full_name,
        serviceName: item?.name ?? "tu sesión",
        category: item?.category ?? null,
        startsAt: row.starts_at,
      });
    } catch (err) {
      console.error(
        `confirmReservation: client notice failed for session ${input.sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Remind if the day's batch already ran (#120): the row was invisible to
  // it while pending.
  if (needsImmediateReminder(row.starts_at, new Date())) {
    await sendImmediateReminder(input.sessionId);
  }

  revalidatePath("/");
  return { ok: true, mirrored };
}

/**
 * Staff reject a public reservation still awaiting confirmation. Cancels the
 * row (frees the slot); a pending reservation is normally not on the calendar,
 * so the mirror is only deleted when an event id is present. A reservation
 * already confirmed is cancelled through cancelSession.
 */
export async function cancelReservation(input: {
  sessionId: string;
}): Promise<{ ok: true } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const db = serviceClient();

  const { data: updated, error } = await db
    .from("sessions")
    .update({ status: "cancelled" })
    .eq("id", input.sessionId)
    .eq("source", "app")
    .eq("pending_confirmation", true)
    .neq("status", "cancelled")
    .select("id, gcal_event_id");
  if (error) {
    return { error: `No se pudo cancelar la reserva: ${error.message}` };
  }
  if (!updated || updated.length === 0) {
    return { error: "No se encontró la reserva." };
  }
  const row = updated[0] as { gcal_event_id?: string | null };

  // A pending row normally has no calendar event; if one exists anyway (an
  // edit predating the mirror guard), don't leave it orphaned. Already-gone
  // is fine (delete tolerates 404/410).
  if (row.gcal_event_id) {
    await mirrorDelete(input.sessionId);
  }
  // Cuponera refund (future sessions only) is the DB trigger's job now —
  // sessions_refund_package_credit on the scheduled→cancelled transition.

  revalidatePath("/");
  return { ok: true };
}

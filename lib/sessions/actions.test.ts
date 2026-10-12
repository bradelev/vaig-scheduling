import { beforeEach, describe, expect, it, vi } from "vitest";

// "use server" modules may only export async functions — mock its two
// dependencies (Supabase + Next's revalidatePath) instead of the module
// itself.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Mock the calendar mirror bridge so tests never hit the network. The mirror
// is best-effort and decoupled; here we just assert it's invoked with the
// right op and never breaks the action.
const mirrorUpsert = vi.fn((_session: unknown, _op: "create" | "update") =>
  Promise.resolve({ ok: true, eventId: "vaig-evt" } as { ok: boolean; eventId?: string; error?: string }),
);
const mirrorDelete = vi.fn((_sessionId: string) =>
  Promise.resolve({ ok: true } as { ok: boolean; error?: string }),
);
vi.mock("./mirror", () => ({
  mirrorUpsert: (session: unknown, op: "create" | "update") => mirrorUpsert(session, op),
  mirrorDelete: (sessionId: string) => mirrorDelete(sessionId),
}));

// Mock the immediate-reminder bridge (no network). needsImmediateReminder is
// controllable per-test; sendImmediateReminder is a spy.
const needsImmediate = vi.fn((_startsAt: string, _now: Date) => false);
const sendImmediate = vi.fn((_sessionId: string) => Promise.resolve(true));
vi.mock("./immediate-reminder", () => ({
  needsImmediateReminder: (s: string, n: Date) => needsImmediate(s, n),
  sendImmediateReminder: (id: string) => sendImmediate(id),
}));

// Mock the in-action staff re-check: allowed by default; a test flips it.
const requireStaff = vi.fn(() =>
  Promise.resolve({ ok: true, email: "staff@example.com" } as { ok: true; email: string } | { error: string }),
);
vi.mock("../auth/require-staff", () => ({
  requireStaff: () => requireStaff(),
}));

// Mock the client-facing confirmation notice (no network). Best-effort in
// the action; here a spy so tests can assert when it's sent and when not.
const notifyClient = vi.fn((_input: unknown) => Promise.resolve());
vi.mock("../booking/notify-client", () => ({
  notifyReservationConfirmed: (input: unknown) => notifyClient(input),
}));

type QueryResult<T = unknown> = { data: T | null; error: { message: string } | null };
type Call = { method: string; args: unknown[] };

/**
 * Minimal chainable mock of the Supabase query builder (thenable): every
 * `.select()/.insert()/.update()/.eq()/...` call is recorded and returns
 * `this`, so any chain shape the action code uses resolves to the
 * configured `result` — either via a terminal call (`.single()` /
 * `.maybeSingle()`) or by awaiting the builder directly (`.then`).
 */
function makeBuilder(result: QueryResult, calls: Call[]) {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "eq", "is", "in", "neq"]) {
    builder[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return builder;
    };
  }
  builder.single = () => Promise.resolve(result);
  builder.maybeSingle = () => Promise.resolve(result);
  builder.then = (
    resolve: (v: QueryResult) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

/** Per-table queue of results, consumed in order by each `.from(table)` call. */
let resultQueue: Record<string, QueryResult[]>;
/** Every recorded call, keyed by table, in `.from(table)` call order. */
let callsByTable: Record<string, Call[][]>;

function queueResult(table: string, result: QueryResult) {
  (resultQueue[table] ??= []).push(result);
}

/** The calls recorded for the Nth (0-indexed) `.from(table)` invocation. */
function callsFor(table: string, index = 0): Call[] {
  return callsByTable[table]?.[index] ?? [];
}

function findCall(calls: Call[], method: string): unknown[] | undefined {
  return calls.find((c) => c.method === method)?.args;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const result = resultQueue[table]?.shift() ?? { data: null, error: null };
      const calls: Call[] = [];
      (callsByTable[table] ??= []).push(calls);
      return makeBuilder(result, calls);
    },
    // RPCs are keyed "rpc:<name>"; the args are recorded as one call.
    rpc: (name: string, args: unknown) => {
      const key = `rpc:${name}`;
      const result = resultQueue[key]?.shift() ?? { data: null, error: null };
      (callsByTable[key] ??= []).push([{ method: "rpc", args: [args] }]);
      return Promise.resolve(result);
    },
  }),
}));

beforeEach(() => {
  resultQueue = {};
  callsByTable = {};
  mirrorUpsert.mockClear();
  mirrorDelete.mockClear();
  needsImmediate.mockClear();
  needsImmediate.mockReturnValue(false);
  sendImmediate.mockClear();
  notifyClient.mockClear();
  requireStaff.mockClear();
  requireStaff.mockResolvedValue({ ok: true, email: "staff@example.com" });
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";
});

describe("createSession", () => {
  it("happy path with an existing clientId", async () => {
    const { createSession } = await import("./actions");
    queueResult("sessions", { data: { id: "sess-1" }, error: null });

    const res = await createSession({
      clientId: "client-1",
      startsAt: "2026-08-10T14:00:00.000Z",
    });

    expect(res).toMatchObject({ sessionId: "sess-1" });
    const insertArgs = findCall(callsFor("sessions"), "insert");
    expect(insertArgs?.[0]).toMatchObject({
      source: "app",
      client_id: "client-1",
      status: "scheduled",
      gcal_event_id: null,
      service: null,
      note: null,
    });
  });

  it("stores a KNOWN attended_by (validated against the staff table)", async () => {
    const { createSession } = await import("./actions");
    queueResult("staff", { data: { id: "lu" }, error: null }); // isKnownStaff → true
    queueResult("sessions", { data: { id: "sess-a" }, error: null }); // insert
    const res = await createSession({
      clientId: "client-1",
      startsAt: "2026-08-10T14:00:00.000Z",
      attendedBy: "lu",
    });
    expect(res).toMatchObject({ sessionId: "sess-a" });
    const insertArgs = findCall(callsFor("sessions"), "insert");
    expect(insertArgs?.[0]).toMatchObject({ attended_by: "lu" });
  });

  it("stores NULL for an UNKNOWN attended_by (never trusts the input)", async () => {
    const { createSession } = await import("./actions");
    queueResult("staff", { data: null, error: null }); // isKnownStaff → false
    queueResult("sessions", { data: { id: "sess-b" }, error: null }); // insert
    await createSession({
      clientId: "client-1",
      startsAt: "2026-08-10T14:00:00.000Z",
      attendedBy: "intruso",
    });
    const insertArgs = findCall(callsFor("sessions"), "insert");
    expect(insertArgs?.[0]).toMatchObject({ attended_by: null });
  });

  it("creates the client inline when newClient is provided (insert)", async () => {
    const { createSession } = await import("./actions");
    queueResult("clients", { data: null, error: null }); // phone lookup: none found
    queueResult("clients", { data: { id: "new-client-1" }, error: null }); // insert result
    queueResult("sessions", { data: { id: "sess-2" }, error: null });

    const res = await createSession({
      newClient: {
        fullName: "Alba Inventada",
        phone: "+59891234567",
        isFirstVisit: true,
      },
      startsAt: "2026-08-10T14:00:00.000Z",
    });

    expect(res).toMatchObject({ sessionId: "sess-2" });
    const insertArgs = findCall(callsFor("clients", 1), "insert");
    expect(insertArgs?.[0]).toEqual({
      full_name: "Alba Inventada",
      phone: "+59891234567",
      is_first_visit: true,
    });
    const sessionInsertArgs = findCall(callsFor("sessions"), "insert");
    expect(sessionInsertArgs?.[0]).toMatchObject({ client_id: "new-client-1" });
  });

  it("passes is_first_visit=false through on inline create", async () => {
    const { createSession } = await import("./actions");
    queueResult("clients", { data: null, error: null });
    queueResult("clients", { data: { id: "new-client-9" }, error: null });
    queueResult("sessions", { data: { id: "sess-9" }, error: null });

    await createSession({
      newClient: {
        fullName: "Beatriz Inventada",
        phone: "099123456",
        isFirstVisit: false,
      },
      startsAt: "2026-08-10T14:00:00.000Z",
    });

    const insertArgs = findCall(callsFor("clients", 1), "insert");
    expect(insertArgs?.[0]).toMatchObject({ is_first_visit: false });
  });

  it("errors when neither clientId nor newClient is provided", async () => {
    const { createSession } = await import("./actions");
    const res = await createSession({ startsAt: "2026-08-10T14:00:00.000Z" });
    expect(res).toEqual({ error: "Falta la clienta." });
  });

  it("errors when both clientId and newClient are provided", async () => {
    const { createSession } = await import("./actions");
    const res = await createSession({
      clientId: "client-1",
      newClient: { fullName: "Alba Inventada", phone: "+59891234567", isFirstVisit: false },
      startsAt: "2026-08-10T14:00:00.000Z",
    });
    expect(res).toEqual({ error: "Falta la clienta." });
  });

  it("errors on an invalid phone", async () => {
    const { createSession } = await import("./actions");
    const res = await createSession({
      newClient: { fullName: "Alba Inventada", phone: "123", isFirstVisit: false },
      startsAt: "2026-08-10T14:00:00.000Z",
    });
    expect(res).toEqual({ error: "El teléfono no es válido." });
  });

  it("errors on a phone conflict (existing client, different name)", async () => {
    const { createSession } = await import("./actions");
    queueResult("clients", {
      data: { id: "client-x", full_name: "Beatriz Existente" },
      error: null,
    });

    const res = await createSession({
      newClient: { fullName: "Alba Inventada", phone: "+59891234567", isFirstVisit: false },
      startsAt: "2026-08-10T14:00:00.000Z",
    });

    expect(res).toEqual({
      error:
        'Ese teléfono ya es de "Beatriz Existente". Si es la misma ' +
        "persona, asignala desde la lista; si no, revisá el número.",
    });
  });

  it("reuses the existing client when name+phone match (idempotent, no insert)", async () => {
    const { createSession } = await import("./actions");
    queueResult("clients", {
      data: { id: "client-existing", full_name: "Alba Inventada" },
      error: null,
    });
    queueResult("sessions", { data: { id: "sess-4" }, error: null });

    const res = await createSession({
      newClient: { fullName: "Alba Inventada", phone: "+59891234567", isFirstVisit: true },
      startsAt: "2026-08-10T14:00:00.000Z",
    });

    expect(res).toMatchObject({ sessionId: "sess-4" });
    // Only one "clients" table call was made — the lookup, no insert.
    expect(callsByTable["clients"]?.length).toBe(1);
    const sessionInsertArgs = findCall(callsFor("sessions"), "insert");
    expect(sessionInsertArgs?.[0]).toMatchObject({ client_id: "client-existing" });
  });

  it("errors when startsAt is missing", async () => {
    const { createSession } = await import("./actions");
    const res = await createSession({ clientId: "client-1", startsAt: "" });
    expect(res).toEqual({ error: "Falta la fecha y hora de inicio." });
  });

  it("errors on a malformed (non-empty) startsAt instead of throwing", async () => {
    const { createSession } = await import("./actions");
    const res = await createSession({ clientId: "client-1", startsAt: "not-a-date" });
    expect(res).toEqual({ error: "La fecha y hora no es válida." });
  });

  it("errors on a service not in the catalog (clean message, no raw trigger)", async () => {
    const { createSession } = await import("./actions");
    queueResult("service_types", { data: null, error: null }); // slug not found
    const res = await createSession({
      clientId: "client-1",
      startsAt: "2026-08-10T14:00:00.000Z",
      service: "no_existe",
    });
    expect(res).toEqual({ error: 'El servicio "no_existe" no es una categoría válida.' });
  });

  it("accepts a valid service category", async () => {
    const { createSession } = await import("./actions");
    queueResult("service_types", { data: { slug: "depilacion" }, error: null });
    queueResult("sessions", { data: { id: "sess-svc" }, error: null });
    const res = await createSession({
      clientId: "client-1",
      startsAt: "2026-08-10T14:00:00.000Z",
      service: "depilacion",
    });
    expect(res).toMatchObject({ sessionId: "sess-svc" });
  });

  it("defaults duration to 60 minutes when omitted", async () => {
    const { createSession } = await import("./actions");
    queueResult("sessions", { data: { id: "sess-5" }, error: null });

    await createSession({
      clientId: "client-1",
      startsAt: "2026-08-10T14:00:00.000Z",
    });

    const insertArgs = findCall(callsFor("sessions"), "insert");
    expect(insertArgs?.[0]).toMatchObject({
      starts_at: "2026-08-10T14:00:00.000Z",
      ends_at: "2026-08-10T15:00:00.000Z",
    });
  });

  it("applies a custom duration when provided", async () => {
    const { createSession } = await import("./actions");
    queueResult("sessions", { data: { id: "sess-6" }, error: null });

    await createSession({
      clientId: "client-1",
      startsAt: "2026-08-10T14:00:00.000Z",
      durationMinutes: 90,
    });

    const insertArgs = findCall(callsFor("sessions"), "insert");
    expect(insertArgs?.[0]).toMatchObject({
      starts_at: "2026-08-10T14:00:00.000Z",
      ends_at: "2026-08-10T15:30:00.000Z",
    });
  });
});

describe("editSession", () => {
  it("updates only the provided fields, guarded to source='app'", async () => {
    const { editSession } = await import("./actions");
    queueResult("service_types", { data: { slug: "depilacion" }, error: null });
    queueResult("sessions", { data: [{ id: "sess-1" }], error: null });

    const res = await editSession({
      sessionId: "sess-1",
      service: "depilacion",
      note: "primera vez",
    });

    expect(res).toEqual({ ok: true });
    const calls = callsFor("sessions");
    expect(findCall(calls, "update")?.[0]).toEqual({
      service: "depilacion",
      note: "primera vez",
    });
    expect(calls).toContainEqual({ method: "eq", args: ["id", "sess-1"] });
    expect(calls).toContainEqual({ method: "eq", args: ["source", "app"] });
    // A cancelled session is read-only (stale-tab race guard).
    expect(calls).toContainEqual({ method: "neq", args: ["status", "cancelled"] });
  });

  it("does NOT mirror a public reservation still awaiting staff confirmation", async () => {
    const { editSession } = await import("./actions");
    queueResult("sessions", { data: [{ id: "sess-p" }], error: null }); // the update
    queueResult("sessions", {
      // mirrorSession's re-read: a pending_confirmation row (migration
      // pending_confirmation) has no calendar event until staff confirm it.
      data: {
        id: "sess-p",
        starts_at: "2026-09-04T17:00:00.000Z",
        ends_at: "2026-09-04T18:00:00.000Z",
        service: "depilacion",
        attended_by: "lu",
        pending_confirmation: true,
        clients: { full_name: "Ana Prueba" },
      },
      error: null,
    });

    const res = await editSession({ sessionId: "sess-p", note: "llega 10 min tarde" });

    expect(res).toEqual({ ok: true });
    expect(mirrorUpsert).not.toHaveBeenCalled();
  });

  it("sets client_id when clientId is provided, and nothing else", async () => {
    const { editSession } = await import("./actions");
    queueResult("sessions", { data: [{ id: "sess-1" }], error: null });

    await editSession({ sessionId: "sess-1", clientId: "client-2" });

    const insertArgs = findCall(callsFor("sessions"), "update");
    expect(insertArgs?.[0]).toEqual({ client_id: "client-2" });
  });

  it("errors when no app-origin row matched (not found / wrong source)", async () => {
    const { editSession } = await import("./actions");
    queueResult("service_types", { data: { slug: "hifu" }, error: null });
    queueResult("sessions", { data: [], error: null });

    const res = await editSession({ sessionId: "missing", service: "hifu" });

    expect(res).toEqual({ error: "No se encontró la sesión." });
  });

  it("errors on a service not in the catalog (clean message)", async () => {
    const { editSession } = await import("./actions");
    queueResult("service_types", { data: null, error: null });
    const res = await editSession({ sessionId: "sess-1", service: "no_existe" });
    expect(res).toEqual({ error: 'El servicio "no_existe" no es una categoría válida.' });
  });

  it("treats an empty-string service as clearing it to null (no catalog check)", async () => {
    const { editSession } = await import("./actions");
    queueResult("sessions", { data: [{ id: "sess-1" }], error: null });
    const res = await editSession({ sessionId: "sess-1", service: "" });
    expect(res).toEqual({ ok: true });
    expect(findCall(callsFor("sessions"), "update")?.[0]).toEqual({ service: null });
  });
});

describe("moveSession", () => {
  it("recomputes ends_at preserving duration AND resets reminder state on a real move", async () => {
    const { moveSession } = await import("./actions");
    queueResult("sessions", {
      data: { starts_at: "2026-08-10T14:00:00.000Z", ends_at: "2026-08-10T15:30:00.000Z" },
      error: null,
    }); // read
    queueResult("sessions", { data: null, error: null }); // update

    const res = await moveSession({
      sessionId: "sess-1",
      startsAt: "2026-08-11T09:00:00.000Z",
    });

    expect(res).toEqual({ ok: true });
    // Original duration was 90 minutes; new ends_at must preserve it, AND the
    // reminder/confirmation state must be cleared so it re-reminds (FR-1).
    const updateArgs = findCall(callsFor("sessions", 1), "update");
    expect(updateArgs?.[0]).toEqual({
      starts_at: "2026-08-11T09:00:00.000Z",
      ends_at: "2026-08-11T10:30:00.000Z",
      reminder_sent_at: null,
      reminder_wamid: null,
      confirmed_at: null,
    });
  });

  it("does NOT reset reminder state when moved to the same instant (no-op)", async () => {
    const { moveSession } = await import("./actions");
    queueResult("sessions", {
      data: { starts_at: "2026-08-10T14:00:00.000Z", ends_at: "2026-08-10T15:00:00.000Z" },
      error: null,
    }); // read
    queueResult("sessions", { data: null, error: null }); // update

    await moveSession({
      sessionId: "sess-1",
      startsAt: "2026-08-10T14:00:00.000Z", // same instant
    });

    const updateArgs = findCall(callsFor("sessions", 1), "update");
    // No reminder fields in the patch — an unchanged time must not wipe a sent reminder.
    expect(updateArgs?.[0]).not.toHaveProperty("reminder_sent_at");
    expect(updateArgs?.[0]).toMatchObject({ starts_at: "2026-08-10T14:00:00.000Z" });
  });

  it("errors on a malformed startsAt instead of throwing", async () => {
    const { moveSession } = await import("./actions");
    const res = await moveSession({ sessionId: "sess-1", startsAt: "garbage" });
    expect(res).toEqual({ error: "La fecha y hora no es válida." });
  });

  it("leaves ends_at null when it was null", async () => {
    const { moveSession } = await import("./actions");
    queueResult("sessions", {
      data: { starts_at: "2026-08-10T14:00:00.000Z", ends_at: null },
      error: null,
    }); // read
    queueResult("sessions", { data: null, error: null }); // update

    const res = await moveSession({
      sessionId: "sess-1",
      startsAt: "2026-08-11T09:00:00.000Z",
    });

    expect(res).toEqual({ ok: true });
    const updateArgs = findCall(callsFor("sessions", 1), "update");
    // Different instant → reminder state also reset (FR-1); ends_at stays null.
    expect(updateArgs?.[0]).toEqual({
      starts_at: "2026-08-11T09:00:00.000Z",
      ends_at: null,
      reminder_sent_at: null,
      reminder_wamid: null,
      confirmed_at: null,
    });
  });

  it("errors when the session is not found", async () => {
    const { moveSession } = await import("./actions");
    queueResult("sessions", { data: null, error: null }); // read: no row

    const res = await moveSession({
      sessionId: "missing",
      startsAt: "2026-08-11T09:00:00.000Z",
    });

    expect(res).toEqual({ error: "No se encontró la sesión." });
  });
});

describe("cancelSession", () => {
  it("sets status to cancelled, guarded to source='app'", async () => {
    const { cancelSession } = await import("./actions");
    queueResult("sessions", { data: [{ id: "sess-1" }], error: null });

    const res = await cancelSession({ sessionId: "sess-1" });

    expect(res).toEqual({ ok: true });
    const calls = callsFor("sessions");
    expect(findCall(calls, "update")?.[0]).toEqual({ status: "cancelled" });
    expect(calls).toContainEqual({ method: "eq", args: ["id", "sess-1"] });
    expect(calls).toContainEqual({ method: "eq", args: ["source", "app"] });
    expect(calls).toContainEqual({ method: "neq", args: ["status", "cancelled"] });
  });

  it("errors when the session is not found", async () => {
    const { cancelSession } = await import("./actions");
    queueResult("sessions", { data: [], error: null });

    const res = await cancelSession({ sessionId: "missing" });

    expect(res).toEqual({ error: "No se encontró la sesión." });
  });
});

describe("dismissMatchedSession", () => {
  it("stamps dismissed_at, guarded to source≠'app' and not-already-dismissed", async () => {
    const { dismissMatchedSession } = await import("./actions");
    queueResult("sessions", { data: [{ id: "sess-x" }], error: null });

    const res = await dismissMatchedSession({ sessionId: "sess-x" });

    expect(res).toEqual({ ok: true });
    const calls = callsFor("sessions");
    // Marks dismissed_at (value is a timestamp; assert the key is present).
    expect(Object.keys(findCall(calls, "update")?.[0] ?? {})).toEqual(["dismissed_at"]);
    expect(calls).toContainEqual({ method: "eq", args: ["id", "sess-x"] });
    expect(calls).toContainEqual({ method: "neq", args: ["source", "app"] });
    expect(calls).toContainEqual({ method: "is", args: ["dismissed_at", null] });
  });

  it("never calls the calendar (an app-side dismiss must not delete a live event)", async () => {
    const { dismissMatchedSession } = await import("./actions");
    queueResult("sessions", { data: [{ id: "sess-x" }], error: null });

    await dismissMatchedSession({ sessionId: "sess-x" });

    expect(mirrorDelete).not.toHaveBeenCalled();
  });

  it("errors when nothing matched (app row, or already dismissed)", async () => {
    const { dismissMatchedSession } = await import("./actions");
    queueResult("sessions", { data: [], error: null });

    const res = await dismissMatchedSession({ sessionId: "sess-app" });

    expect(res).toEqual({ error: "No se encontró la sesión." });
  });
});

describe("calendar mirror wiring (#118)", () => {
  it("createSession invokes the mirror with op=create and PATCHes the event id", async () => {
    const { createSession } = await import("./actions");
    queueResult("sessions", { data: { id: "sess-m1" }, error: null }); // insert
    queueResult("sessions", {
      data: { id: "sess-m1", starts_at: "2026-08-10T14:00:00.000Z", ends_at: "2026-08-10T15:00:00.000Z", service: "hifu", clients: { full_name: "Alba Inventada" } },
      error: null,
    }); // mirrorSession read
    queueResult("service_types", { data: { slug: "hifu" }, error: null });
    // reorder: service check runs before insert; queue it first
    resultQueue = { service_types: [{ data: { slug: "hifu" }, error: null }], sessions: [
      { data: { id: "sess-m1" }, error: null },
      { data: { id: "sess-m1", starts_at: "2026-08-10T14:00:00.000Z", ends_at: "2026-08-10T15:00:00.000Z", service: "hifu", clients: { full_name: "Alba Inventada" } }, error: null },
      { data: [{ id: "sess-m1" }], error: null }, // gcal patch
    ] };

    await createSession({ clientId: "client-1", startsAt: "2026-08-10T14:00:00.000Z", service: "hifu" });

    expect(mirrorUpsert).toHaveBeenCalledTimes(1);
    expect(mirrorUpsert.mock.calls[0][1]).toBe("create");
  });

  it("cancelSession invokes mirrorDelete", async () => {
    const { cancelSession } = await import("./actions");
    queueResult("sessions", { data: [{ id: "sess-m2" }], error: null });
    await cancelSession({ sessionId: "sess-m2" });
    expect(mirrorDelete).toHaveBeenCalledWith("sess-m2");
  });

  it("a mirror failure never fails the create (best-effort)", async () => {
    const { createSession } = await import("./actions");
    mirrorUpsert.mockResolvedValueOnce({ ok: false, error: "calendar down" } as never);
    resultQueue = { sessions: [
      { data: { id: "sess-m3" }, error: null }, // insert
      { data: { id: "sess-m3", starts_at: "2026-08-10T14:00:00.000Z", ends_at: null, service: null, clients: { full_name: "Alba Inventada" } }, error: null }, // mirror read
    ] };
    const res = await createSession({ clientId: "client-1", startsAt: "2026-08-10T14:00:00.000Z" });
    // Still succeeds (best-effort), but now REPORTS mirrored:false so the UI
    // can warn the operator instead of a silent "creada".
    expect(res).toEqual({ sessionId: "sess-m3", mirrored: false });
    mirrorUpsert.mockClear();
  });

  it("reports mirrored:true when the calendar write succeeds", async () => {
    const { createSession } = await import("./actions");
    // Default mock returns { ok: true, eventId: "vaig-evt" }.
    resultQueue = { sessions: [
      { data: { id: "sess-m4" }, error: null }, // insert
      { data: { id: "sess-m4", starts_at: "2026-08-10T14:00:00.000Z", ends_at: null, service: null, clients: { full_name: "Alba Inventada" } }, error: null }, // mirror read
      { data: [{ id: "sess-m4" }], error: null }, // gcal patch
    ] };
    const res = await createSession({ clientId: "client-1", startsAt: "2026-08-10T14:00:00.000Z" });
    expect(res).toEqual({ sessionId: "sess-m4", mirrored: true });
    mirrorUpsert.mockClear();
  });

  it("still reports mirrored:true when the event is written but the gcal patch-back fails", async () => {
    const { createSession } = await import("./actions");
    // Event written OK, but the patch-back UPDATE errors. The event IS on the
    // calendar, so from the operator's view the mirror succeeded — the failed
    // link is an internal issue (logged), not a mirror failure.
    resultQueue = { sessions: [
      { data: { id: "sess-m5" }, error: null }, // insert
      { data: { id: "sess-m5", starts_at: "2026-08-10T14:00:00.000Z", ends_at: null, service: null, clients: { full_name: "Alba Inventada" } }, error: null }, // mirror read
      { data: null, error: { message: "patch failed" } }, // gcal patch fails
    ] };
    const res = await createSession({ clientId: "client-1", startsAt: "2026-08-10T14:00:00.000Z" });
    expect(res).toEqual({ sessionId: "sess-m5", mirrored: true });
    mirrorUpsert.mockClear();
  });

  it("reports mirrored:false when the session row can't be read back for the mirror", async () => {
    const { createSession } = await import("./actions");
    // Insert succeeds, but the mirror-read returns no row → the mirror can't
    // run and can't be confirmed → warn the operator (mirrored:false).
    resultQueue = { sessions: [
      { data: { id: "sess-m6" }, error: null }, // insert
      { data: null, error: null }, // mirror read: no row
    ] };
    const res = await createSession({ clientId: "client-1", startsAt: "2026-08-10T14:00:00.000Z" });
    expect(res).toEqual({ sessionId: "sess-m6", mirrored: false });
    expect(mirrorUpsert).not.toHaveBeenCalled(); // never even attempted the write
    mirrorUpsert.mockClear();
  });
});

describe("immediate reminder wiring (#120)", () => {
  it("createSession fires the immediate reminder when the batch window has passed", async () => {
    const { createSession } = await import("./actions");
    needsImmediate.mockReturnValue(true);
    queueResult("sessions", { data: { id: "sess-imm" }, error: null }); // insert
    queueResult("sessions", {
      data: { id: "sess-imm", starts_at: "x", ends_at: null, service: null, clients: { full_name: "Ada" } },
      error: null,
    }); // mirror read
    await createSession({ clientId: "client-1", startsAt: "2026-08-10T20:00:00.000Z" });
    expect(sendImmediate).toHaveBeenCalledWith("sess-imm");
  });

  it("createSession does NOT fire when the batch will cover it", async () => {
    const { createSession } = await import("./actions");
    needsImmediate.mockReturnValue(false); // (also the default)
    queueResult("sessions", { data: { id: "sess-b" }, error: null });
    queueResult("sessions", {
      data: { id: "sess-b", starts_at: "x", ends_at: null, service: null, clients: { full_name: "Ada" } },
      error: null,
    });
    await createSession({ clientId: "client-1", startsAt: "2026-08-10T10:00:00.000Z" });
    expect(sendImmediate).not.toHaveBeenCalled();
  });
});

describe("confirmReservation (public booking → firm appointment)", () => {
  const confirmedRow = {
    id: "sess-p",
    starts_at: "2026-09-07T17:00:00.000Z",
    clients: { full_name: "Ana Prueba", phone: "+59891234567", opted_out: false },
    booking_services: { name: "Pierna entera", category: "Depilación Láser" },
  };

  it("clears the flag (guarded), mirrors with 'create', and notifies the client", async () => {
    const { confirmReservation } = await import("./actions");
    queueResult("sessions", { data: [confirmedRow], error: null }); // the update
    queueResult("sessions", {
      // mirrorSession's re-read — no longer pending
      data: {
        id: "sess-p",
        starts_at: confirmedRow.starts_at,
        ends_at: "2026-09-07T18:00:00.000Z",
        service: "depilacion",
        attended_by: "lu",
        pending_confirmation: false,
        clients: { full_name: "Ana Prueba" },
      },
      error: null,
    });

    const res = await confirmReservation({ sessionId: "sess-p" });

    expect(res).toEqual({ ok: true, mirrored: true });
    const calls = callsFor("sessions");
    expect(findCall(calls, "update")?.[0]).toEqual({ pending_confirmation: false });
    expect(calls).toContainEqual({ method: "eq", args: ["id", "sess-p"] });
    expect(calls).toContainEqual({ method: "eq", args: ["source", "app"] });
    expect(calls).toContainEqual({ method: "eq", args: ["pending_confirmation", true] });
    expect(calls).toContainEqual({ method: "eq", args: ["status", "scheduled"] });
    expect(mirrorUpsert).toHaveBeenCalledWith(expect.objectContaining({ id: "sess-p" }), "create");
    expect(notifyClient).toHaveBeenCalledWith({
      clientPhone: "+59891234567",
      clientName: "Ana Prueba",
      serviceName: "Pierna entera",
      category: "Depilación Láser",
      startsAt: confirmedRow.starts_at,
    });
  });

  it("does not notify an opted-out client, and a notice failure never undoes the confirm", async () => {
    const { confirmReservation } = await import("./actions");
    queueResult("sessions", {
      data: [{ ...confirmedRow, clients: { ...confirmedRow.clients, opted_out: true } }],
      error: null,
    });
    queueResult("sessions", { data: { id: "sess-p", pending_confirmation: false, clients: null }, error: null });
    expect(await confirmReservation({ sessionId: "sess-p" })).toEqual({ ok: true, mirrored: true });
    expect(notifyClient).not.toHaveBeenCalled();

    queueResult("sessions", { data: [confirmedRow], error: null });
    queueResult("sessions", { data: { id: "sess-p", pending_confirmation: false, clients: null }, error: null });
    notifyClient.mockRejectedValueOnce(new Error("template not approved"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await confirmReservation({ sessionId: "sess-p" })).toEqual({ ok: true, mirrored: true });
    err.mockRestore();
  });

  it("sends the immediate reminder when the day's batch already ran (#120) — AFTER the client notice", async () => {
    const { confirmReservation } = await import("./actions");
    needsImmediate.mockReturnValueOnce(true);
    queueResult("sessions", { data: [confirmedRow], error: null });
    queueResult("sessions", { data: { id: "sess-p", pending_confirmation: false, clients: null }, error: null });
    await confirmReservation({ sessionId: "sess-p" });
    expect(sendImmediate).toHaveBeenCalledWith("sess-p");
    // "quedó confirmada" must land before "te recordamos".
    expect(notifyClient.mock.invocationCallOrder[0]).toBeLessThan(
      sendImmediate.mock.invocationCallOrder[0],
    );
  });

  it("masks the online-booking placeholder name in the client notice", async () => {
    const { confirmReservation } = await import("./actions");
    queueResult("sessions", {
      data: [{ ...confirmedRow, clients: { ...confirmedRow.clients, full_name: "Cliente (reserva online)" } }],
      error: null,
    });
    queueResult("sessions", { data: { id: "sess-p", pending_confirmation: false, clients: null }, error: null });
    await confirmReservation({ sessionId: "sess-p" });
    expect(notifyClient).toHaveBeenCalledWith(expect.objectContaining({ clientName: null }));
  });

  it("refuses a non-staff caller before touching anything", async () => {
    const { confirmReservation } = await import("./actions");
    requireStaff.mockResolvedValueOnce({ error: "No autorizado." });
    expect(await confirmReservation({ sessionId: "sess-p" })).toEqual({ error: "No autorizado." });
    expect(callsByTable.sessions).toBeUndefined();
    expect(mirrorUpsert).not.toHaveBeenCalled();
  });

  it("errors when nothing matched (already confirmed / cancelled / not app)", async () => {
    const { confirmReservation } = await import("./actions");
    queueResult("sessions", { data: [], error: null });
    expect(await confirmReservation({ sessionId: "x" })).toEqual({ error: "No se encontró la reserva." });
    expect(mirrorUpsert).not.toHaveBeenCalled();
    expect(notifyClient).not.toHaveBeenCalled();
  });
});

describe("cancelReservation (reject a pending public reservation)", () => {
  it("cancels a pending row without touching the calendar", async () => {
    const { cancelReservation } = await import("./actions");
    queueResult("sessions", { data: [{ id: "sess-p" }], error: null });
    expect(await cancelReservation({ sessionId: "sess-p" })).toEqual({ ok: true });
    const calls = callsFor("sessions");
    expect(findCall(calls, "update")?.[0]).toEqual({ status: "cancelled" });
    expect(calls).toContainEqual({ method: "eq", args: ["pending_confirmation", true] });
    expect(calls).toContainEqual({ method: "eq", args: ["source", "app"] });
    expect(mirrorDelete).not.toHaveBeenCalled();
  });

  it("makes NO ledger call — the DB trigger owns the cuponera refund (double-refund guard)", async () => {
    const { cancelReservation } = await import("./actions");
    queueResult("sessions", { data: [{ id: "sess-p", gcal_event_id: null }], error: null });
    expect(await cancelReservation({ sessionId: "sess-p" })).toEqual({ ok: true });
    // The refund happens in sessions_refund_package_credit (migration
    // package_credit_integrity); an app-side refund here would refund TWICE.
    expect(callsByTable["rpc:adjust_package_credit"]).toBeUndefined();
  });

  it("deletes the mirror only when an event id exists (defensive)", async () => {
    const { cancelReservation } = await import("./actions");
    queueResult("sessions", { data: [{ id: "sess-p", gcal_event_id: "vaig-evt" }], error: null });
    expect(await cancelReservation({ sessionId: "sess-p" })).toEqual({ ok: true });
    expect(mirrorDelete).toHaveBeenCalledWith("sess-p");
  });

  it("errors when the row isn't a pending reservation", async () => {
    const { cancelReservation } = await import("./actions");
    queueResult("sessions", { data: [], error: null });
    expect(await cancelReservation({ sessionId: "x" })).toEqual({ error: "No se encontró la reserva." });
  });

  it("refuses a non-staff caller", async () => {
    const { cancelReservation } = await import("./actions");
    requireStaff.mockResolvedValueOnce({ error: "No autorizado." });
    expect(await cancelReservation({ sessionId: "sess-p" })).toEqual({ error: "No autorizado." });
    expect(callsByTable.sessions).toBeUndefined();
  });
});

describe("cancelSession and the cuponera ledger", () => {
  it("makes NO ledger call — the refund (future sessions only) lives in the DB trigger", async () => {
    const { cancelSession } = await import("./actions");
    queueResult("sessions", { data: [{ id: "sess-1" }], error: null });
    expect(await cancelSession({ sessionId: "sess-1" })).toEqual({ ok: true });
    // sessions_refund_package_credit fires on the scheduled→cancelled
    // transition for EVERY path (app, sync-calendar, SQL); refunding here too
    // would give the credit back twice. Integration tests cover the trigger.
    expect(callsByTable["rpc:adjust_package_credit"]).toBeUndefined();
  });
});

describe("moveSession on a public reservation still pending", () => {
  it("moves it but never fires the immediate reminder (send-reminders excludes pending rows)", async () => {
    const { moveSession } = await import("./actions");
    needsImmediate.mockReturnValue(true);
    queueResult("sessions", {
      data: {
        starts_at: "2026-08-10T14:00:00.000Z",
        ends_at: "2026-08-10T15:00:00.000Z",
        pending_confirmation: true,
      },
      error: null,
    }); // read
    queueResult("sessions", { data: null, error: null }); // update

    const res = await moveSession({ sessionId: "sess-p", startsAt: "2026-08-11T09:00:00.000Z" });

    expect(res).toEqual({ ok: true });
    expect(sendImmediate).not.toHaveBeenCalled();
  });
});

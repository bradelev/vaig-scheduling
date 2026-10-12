/**
 * Pipeline tests for sync-calendar (issue E2-T3) against fakes — no network,
 * no database. Covers the FR-1 orchestration ACs: idempotency, reschedule
 * reset, job_runs audit, cascade over the fixtures. Invented data only.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Deps, runSync } from "./run.ts";
import type { RawEvent } from "./logic.ts";
import fixture from "../../../fixtures/gcal-events.json" with { type: "json" };

const NOW = new Date("2026-07-19T12:00:00Z");

/**
 * In-memory stand-in for the sessions/clients/aliases tables. Applies the
 * same upsert-by-gcal-id and match semantics the real adapters do, so two
 * runs against it exercise real idempotency.
 */
function makeDb(opts: {
  events: RawEvent[];
  clients?: { id: string; phone: string }[];
  aliases?: { client_id: string; alias_tokens: string[] }[];
}) {
  type Sess = {
    id: string;
    gcal_event_id: string;
    starts_at: string;
    status: string;
    client_id: string | null;
    match_method: string | null;
    raw_title: string;
    raw_description: string | null;
    source: string;
    service: string | null;
    reminder_sent_at: string | null;
    reminder_wamid: string | null;
    confirmed_at: string | null;
    dismissed_at: string | null;
  };
  const sessions = new Map<string, Sess>();
  const clients = opts.clients ?? [];
  const aliases = [...(opts.aliases ?? [])];
  const rawAliasKeys = new Set<string>();
  const jobRuns: { ok: boolean; detail: unknown }[] = [];
  const dismissCalls: string[][] = [];
  let seq = 0;

  const deps: Deps = {
    now: () => NOW,
    fetchEvents: () => Promise.resolve(opts.events),
    fetchExisting: (ids) =>
      Promise.resolve(
        ids
          .map((id) => sessions.get(id))
          .filter((s): s is Sess => Boolean(s))
          .map((s) => ({
            gcal_event_id: s.gcal_event_id,
            starts_at: s.starts_at,
            reminder_sent_at: s.reminder_sent_at,
            status: s.status,
          })),
      ),
    upsertSessions: (rows) => {
      for (const r of rows) {
        const prev = sessions.get(r.gcal_event_id);
        if (prev) {
          // Apply exactly the payload keys, as PostgREST upsert does — so a
          // regression that re-adds `service` to the payload would surface.
          Object.assign(prev, r);
        } else {
          sessions.set(r.gcal_event_id, {
            id: `sess-${seq++}`,
            gcal_event_id: r.gcal_event_id,
            starts_at: r.starts_at,
            status: r.status,
            client_id: null,
            match_method: null,
            raw_title: r.raw_title,
            raw_description: r.raw_description,
            source: r.source,
            service: null,
            dismissed_at: null,
            reminder_sent_at: null,
            reminder_wamid: null,
            confirmed_at: null,
          });
        }
      }
      return Promise.resolve();
    },
    resetReminder: (ids) => {
      for (const id of ids) {
        const s = sessions.get(id);
        if (s) {
          s.reminder_sent_at = null;
          s.reminder_wamid = null;
          s.confirmed_at = null;
        }
      }
      return Promise.resolve();
    },
    cancelExisting: (ids) => {
      for (const id of ids) {
        const s = sessions.get(id);
        if (s) s.status = "cancelled";
      }
      return Promise.resolve();
    },
    fetchUnmatched: () =>
      Promise.resolve(
        [...sessions.values()]
          .filter((s) => s.client_id === null && s.status !== "cancelled")
          .map((s) => ({
            id: s.id,
            gcal_event_id: s.gcal_event_id,
            raw_title: s.raw_title,
            raw_description: s.raw_description,
            source: s.source,
          })),
      ),
    fetchClients: () => Promise.resolve(clients),
    fetchAliases: () => Promise.resolve(aliases.map((a) => ({ ...a }))),
    applyMatch: (sessionId, clientId, method) => {
      const s = [...sessions.values()].find((x) => x.id === sessionId);
      if (s) {
        s.client_id = clientId;
        s.match_method = method;
      }
      return Promise.resolve();
    },
    insertAliases: (rows) => {
      for (const r of rows) {
        if (rawAliasKeys.has(r.raw_alias)) continue; // unique(raw_alias)
        rawAliasKeys.add(r.raw_alias);
        aliases.push({ client_id: r.client_id, alias_tokens: r.alias_tokens });
      }
      return Promise.resolve();
    },
    dismissDiscarded: (ids) => {
      dismissCalls.push(ids);
      // Mirror the real adapter's guards: unmatched only, not yet
      // dismissed, and the dismissal is stamped (idempotency depends on it).
      let n = 0;
      for (const id of ids) {
        const s = sessions.get(id);
        if (s && s.client_id === null && s.dismissed_at === null) {
          s.dismissed_at = NOW.toISOString();
          n++;
        }
      }
      return Promise.resolve(n);
    },
    startJobRun: () => Promise.resolve(`job-${jobRuns.length}`),
    finishJobRun: (_id, ok, detail) => {
      jobRuns.push({ ok, detail });
      return Promise.resolve();
    },
  };

  return { deps, sessions, aliases, jobRuns, dismissCalls };
}

Deno.test("classifies + inserts only real sessions from the fixtures (AC 4/5)", async () => {
  const { deps, sessions, jobRuns } = makeDb({
    events: fixture.items as RawEvent[],
  });
  const { ok, detail } = await runSync(deps);

  assert(ok);
  assertEquals(sessions.size, 17); // 30 events − 13 discards
  assertEquals(detail.seen, 30);
  assertEquals(detail.created, 17);
  // Audit records discards per reason (§7.0).
  const discarded = detail.discarded as Record<string, { count: number }>;
  assertEquals(discarded.all_day.count, 2);
  assertEquals(discarded.employee_availability.count, 4);
  assertEquals(discarded.admin_chore.count, 7);
  assertEquals(jobRuns[0].ok, true);
});

Deno.test("matches by phone and learns an alias for the free (AC 1)", async () => {
  const { deps, sessions, aliases } = makeDb({
    events: [(fixture.items as RawEvent[]).find((e) => e.id.endsWith("ko01"))!],
    clients: [{ id: "client-ag", phone: "+59891112233" }],
  });
  await runSync(deps);

  const s = [...sessions.values()][0];
  assertEquals(s.client_id, "client-ag");
  assertEquals(s.match_method, "phone");
  // Learned "agustina piriz" alias.
  assert(
    aliases.some((a) =>
      a.client_id === "client-ag" &&
      a.alias_tokens.join(" ") === "agustina piriz"
    ),
  );
});

Deno.test("matches by alias when a learned alias identifies the manual event", async () => {
  const external = (fixture.items as RawEvent[]).find((e) => e.id.endsWith("ko06"))!;
  const manual = (fixture.items as RawEvent[]).find((e) => e.id.endsWith("ma01"))!;
  const { deps, sessions } = makeDb({
    // External (with phone) teaches "paula silveira"; the manual dup then
    // resolves by alias in the same run.
    events: [external, manual],
    clients: [{ id: "client-paula", phone: "+59895556677" }],
  });
  await runSync(deps);

  const manualSess = [...sessions.values()].find((s) =>
    s.gcal_event_id.endsWith("ma01")
  )!;
  assertEquals(manualSess.client_id, "client-paula");
  assertEquals(manualSess.match_method, "alias");
});

Deno.test("idempotent: two runs = same state (AC 2)", async () => {
  const events = fixture.items as RawEvent[];
  const { deps, sessions, aliases, jobRuns } = makeDb({
    events,
    clients: [{ id: "client-ag", phone: "+59891112233" }],
  });
  await runSync(deps);
  const snapshot1 = {
    sessions: sessions.size,
    matched: [...sessions.values()].filter((s) => s.client_id).length,
    aliases: aliases.length,
  };
  await runSync(deps);
  const snapshot2 = {
    sessions: sessions.size,
    matched: [...sessions.values()].filter((s) => s.client_id).length,
    aliases: aliases.length,
  };

  assertEquals(snapshot2, snapshot1);
  // Second run creates nothing new.
  assertEquals((jobRuns[1].detail as { created: number }).created, 0);
  assertEquals((jobRuns[1].detail as { aliases_learned: number }).aliases_learned, 0);
});

Deno.test("reschedule: date change with reminder sent resets reminder state (AC 3)", async () => {
  const base = (fixture.items as RawEvent[]).find((e) => e.id.endsWith("ma03"))!;
  const { deps, sessions } = makeDb({ events: [base] });
  await runSync(deps);

  // Simulate a reminder already sent on that session.
  const s = [...sessions.values()][0];
  s.reminder_sent_at = "2026-07-19T13:00:00Z";
  s.reminder_wamid = "wamid.PREVIOUS";
  s.confirmed_at = "2026-07-19T13:05:00Z";

  // Same event id, new starts_at → reschedule.
  const moved: RawEvent = {
    ...base,
    start: { dateTime: "2026-07-25T17:30:00-03:00", timeZone: "America/Montevideo" },
  };
  const run2 = makeDbReusing(deps, sessions, [moved]);
  await runSync(run2.deps);

  const after = [...sessions.values()][0];
  assertEquals(after.starts_at, "2026-07-25T17:30:00-03:00");
  assertEquals(after.reminder_sent_at, null);
  assertEquals(after.reminder_wamid, null);
  assertEquals(after.confirmed_at, null);
});

Deno.test("no date change = no reminder reset", async () => {
  const base = (fixture.items as RawEvent[]).find((e) => e.id.endsWith("ma03"))!;
  const { deps, sessions } = makeDb({ events: [base] });
  await runSync(deps);
  const s = [...sessions.values()][0];
  s.reminder_sent_at = "2026-07-19T13:00:00Z";
  s.reminder_wamid = "wamid.KEEP";

  const run2 = makeDbReusing(deps, sessions, [base]); // identical event
  await runSync(run2.deps);

  assertEquals([...sessions.values()][0].reminder_sent_at, "2026-07-19T13:00:00Z");
  assertEquals([...sessions.values()][0].reminder_wamid, "wamid.KEEP");
});

Deno.test("cancelled event is stored but never matched", async () => {
  const cancelled = (fixture.items as RawEvent[]).find((e) => e.id.endsWith("ko03"))!;
  const { deps, sessions } = makeDb({
    events: [cancelled],
    clients: [{ id: "client-x", phone: "+59893334455" }],
  });
  await runSync(deps);
  const s = [...sessions.values()][0];
  assertEquals(s.status, "cancelled");
  assertEquals(s.client_id, null); // cancelled → excluded from the cascade
});

Deno.test("cancelled tombstone (no start/summary) flips an existing row (R1)", async () => {
  const base = (fixture.items as RawEvent[]).find((e) => e.id.endsWith("ma03"))!;
  const { deps, sessions } = makeDb({ events: [base] });
  await runSync(deps);
  assertEquals([...sessions.values()][0].status, "scheduled");

  // Google returns the cancellation as a bare tombstone — no start, no title.
  const tombstone: RawEvent = { id: base.id, status: "cancelled" };
  const run2 = makeDbReusing(deps, sessions, [tombstone]);
  const { detail } = await runSync(run2.deps);

  assertEquals([...sessions.values()][0].status, "cancelled");
  // A tombstone is not an all-day discard.
  const discarded = (detail.discarded ?? {}) as Record<string, unknown>;
  assertEquals(discarded.all_day, undefined);
});

Deno.test("upsert never overwrites service (R2)", async () => {
  const base = (fixture.items as RawEvent[]).find((e) => e.id.endsWith("ma03"))!;
  const { deps, sessions } = makeDb({ events: [base] });
  await runSync(deps);
  // Staff sets a service later.
  [...sessions.values()][0].service = "maderoterapia";

  const run2 = makeDbReusing(deps, sessions, [base]);
  await runSync(run2.deps);

  assertEquals([...sessions.values()][0].service, "maderoterapia");
});

Deno.test("holistic cascade over the fixtures: expected matches vs queue (AC 1)", async () => {
  const events = fixture.items as RawEvent[];
  // Seed clients for two External phones and one pre-existing alias.
  const { deps, sessions } = makeDb({
    events,
    clients: [
      { id: "cli-agustina", phone: "+59891112233" }, // ko01
      { id: "cli-paula", phone: "+59895556677" }, // ko06 (+ ma01 dup by alias)
    ],
    aliases: [
      // A curated alias resolves the manual "josefina recoba" session.
      { client_id: "cli-josefina", alias_tokens: ["josefina", "recoba"] },
    ],
  });
  const { detail } = await runSync(deps);

  const matched = [...sessions.values()].filter((s) => s.client_id !== null);
  const byMethod = (m: string) =>
    matched.filter((s) => s.match_method === m).map((s) => s.gcal_event_id.slice(-4));

  // Phone: ko01 (agustina), ko06 (paula).
  assertEquals(byMethod("phone").sort(), ["ko01", "ko06"]);
  // Alias: ma01 (paula dup, learned from ko06) + ma03 (josefina, curated).
  assertEquals(byMethod("alias").sort(), ["ma01", "ma03"]);
  // 18 sessions − 3 cancelled (excluded from the cascade) = 15 candidates;
  // 4 match (2 phone, 2 alias), the remaining 11 queue.
  assertEquals((detail.matched as { phone: number; alias: number }), {
    phone: 2,
    alias: 2,
  });
  assertEquals(detail.queued, 11);
});

/**
 * Reuses the same session store across a second run with a new event set —
 * needed for reschedule/idempotency scenarios that mutate then re-sync.
 */
function makeDbReusing(
  _prev: Deps,
  sessions: Map<string, {
    id: string;
    gcal_event_id: string;
    starts_at: string;
    status: string;
    client_id: string | null;
    match_method: string | null;
    raw_title: string;
    raw_description: string | null;
    source: string;
    reminder_sent_at: string | null;
    reminder_wamid: string | null;
    confirmed_at: string | null;
  }>,
  events: RawEvent[],
) {
  const jobRuns: { ok: boolean; detail: unknown }[] = [];
  const deps: Deps = {
    now: () => NOW,
    fetchEvents: () => Promise.resolve(events),
    fetchExisting: (ids) =>
      Promise.resolve(
        ids
          .map((id) => sessions.get(id))
          .filter((s): s is NonNullable<typeof s> => Boolean(s))
          .map((s) => ({
            gcal_event_id: s.gcal_event_id,
            starts_at: s.starts_at,
            reminder_sent_at: s.reminder_sent_at,
            status: s.status,
          })),
      ),
    upsertSessions: (rows) => {
      for (const r of rows) {
        const prev = sessions.get(r.gcal_event_id);
        if (prev) {
          prev.starts_at = r.starts_at;
          prev.status = r.status;
        }
      }
      return Promise.resolve();
    },
    cancelExisting: (ids) => {
      for (const id of ids) {
        const s = sessions.get(id);
        if (s) s.status = "cancelled";
      }
      return Promise.resolve();
    },
    resetReminder: (ids) => {
      for (const id of ids) {
        const s = sessions.get(id);
        if (s) {
          s.reminder_sent_at = null;
          s.reminder_wamid = null;
          s.confirmed_at = null;
        }
      }
      return Promise.resolve();
    },
    fetchUnmatched: () => Promise.resolve([]),
    fetchClients: () => Promise.resolve([]),
    fetchAliases: () => Promise.resolve([]),
    applyMatch: () => Promise.resolve(),
    insertAliases: () => Promise.resolve(),
    dismissDiscarded: () => Promise.resolve(0),
    startJobRun: () => Promise.resolve("job-r"),
    finishJobRun: (_id, ok, detail) => {
      jobRuns.push({ ok, detail });
      return Promise.resolve();
    },
  };
  return { deps, jobRuns };
}

Deno.test("same instant in a different offset format is NOT a reschedule (issue #64)", async () => {
  const base = (fixture.items as RawEvent[]).find((e) => e.id.endsWith("ma03"))!;
  const { deps, sessions } = makeDb({ events: [base] });
  await runSync(deps);

  const s = [...sessions.values()][0];
  // Simulate PostgREST: the DB re-emits the SAME instant normalized to UTC.
  s.starts_at = new Date(s.starts_at).toISOString().replace("Z", "+00:00");
  s.reminder_sent_at = "2026-07-19T13:00:00Z";
  s.reminder_wamid = "wamid.KEEP";
  s.confirmed_at = "2026-07-19T13:05:00Z";

  // Identical calendar event (local-offset string) → must NOT reset.
  const run2 = makeDbReusing(deps, sessions, [base]);
  const { detail } = await runSync(run2.deps);

  const after = [...sessions.values()][0];
  assertEquals(after.reminder_sent_at, "2026-07-19T13:00:00Z");
  assertEquals(after.reminder_wamid, "wamid.KEEP");
  assertEquals(after.confirmed_at, "2026-07-19T13:05:00Z");
  assertEquals(detail.rescheduled, 0);
});

Deno.test("hourly upsert preserves reschedule_requested on an unmoved event (issue #64)", async () => {
  const base = (fixture.items as RawEvent[]).find((e) => e.id.endsWith("ma03"))!;
  const { deps, sessions } = makeDb({ events: [base] });
  await runSync(deps);

  const s = [...sessions.values()][0];
  s.status = "reschedule_requested"; // set by the webhook (issue #62)
  s.starts_at = new Date(s.starts_at).toISOString().replace("Z", "+00:00");

  const run2 = makeDbReusing(deps, sessions, [base]);
  await runSync(run2.deps);

  assertEquals([...sessions.values()][0].status, "reschedule_requested");
});

Deno.test("a REAL calendar move returns a reschedule_requested row to scheduled (issue #64)", async () => {
  const base = (fixture.items as RawEvent[]).find((e) => e.id.endsWith("ma03"))!;
  const { deps, sessions } = makeDb({ events: [base] });
  await runSync(deps);

  const s = [...sessions.values()][0];
  s.status = "reschedule_requested";
  s.reminder_sent_at = "2026-07-19T13:00:00Z";

  const moved: RawEvent = {
    ...base,
    start: { dateTime: "2026-07-28T10:00:00-03:00", timeZone: "America/Montevideo" },
  };
  const run2 = makeDbReusing(deps, sessions, [moved]);
  await runSync(run2.deps);

  const after = [...sessions.values()][0];
  // Fresh cycle: back to scheduled, marks cleared → she gets a new reminder.
  assertEquals(after.status, "scheduled");
  assertEquals(after.reminder_sent_at, null);
});

Deno.test("calendar cancellation beats a preserved reschedule_requested (issue #64)", async () => {
  const base = (fixture.items as RawEvent[]).find((e) => e.id.endsWith("ma03"))!;
  const { deps, sessions } = makeDb({ events: [base] });
  await runSync(deps);

  [...sessions.values()][0].status = "reschedule_requested";

  const tombstone: RawEvent = { id: base.id, status: "cancelled" };
  const run2 = makeDbReusing(deps, sessions, [tombstone]);
  await runSync(run2.deps);

  assertEquals([...sessions.values()][0].status, "cancelled");
});

Deno.test("a session-shaped cancelled event also beats preserved reschedule_requested (issue #64)", async () => {
  const base = (fixture.items as RawEvent[]).find((e) => e.id.endsWith("ma03"))!;
  const { deps, sessions } = makeDb({ events: [base] });
  await runSync(deps);

  [...sessions.values()][0].status = "reschedule_requested";

  // Cancelled WITH start/summary intact: routes through the upsert path
  // (not cancelOnly), exercising the u.status === "scheduled" guard.
  const cancelled: RawEvent = { ...base, status: "cancelled" };
  const run2 = makeDbReusing(deps, sessions, [cancelled]);
  await runSync(run2.deps);

  assertEquals([...sessions.values()][0].status, "cancelled");
});

Deno.test("self-heal: leftover row whose event now classifies as discard is dismissed (issue #84)", async () => {
  // Run 1: the event is session-shaped and gets a row.
  const { deps, sessions, dismissCalls } = makeDb({
    events: [{
      id: "ev-legacy",
      summary: "Cita real de prueba",
      start: { dateTime: "2026-07-27T12:00:00-03:00" },
      end: { dateTime: "2026-07-27T13:00:00-03:00" },
    }] as RawEvent[],
  });
  await runSync(deps);
  assert(sessions.has("ev-legacy"));
  assertEquals(dismissCalls.length, 0); // no discards, no self-heal call

  // Run 2: the same event was edited into a chore, plus a chore that never
  // had a row. The classifier discards both; only the leftover heals.
  deps.fetchEvents = () =>
    Promise.resolve([
      {
        id: "ev-legacy",
        summary: "FACTURA GANISOL (MDEO COMM) VENCE EL 10",
        start: { dateTime: "2026-07-27T12:00:00-03:00" },
        end: { dateTime: "2026-07-27T13:00:00-03:00" },
      },
      {
        id: "ev-never-synced",
        summary: "VENCE UTE",
        start: { dateTime: "2026-07-28T12:00:00-03:00" },
        end: { dateTime: "2026-07-28T13:00:00-03:00" },
      },
    ] as RawEvent[]);
  const { detail } = await runSync(deps);

  assertEquals(dismissCalls, [["ev-legacy", "ev-never-synced"]]);
  assertEquals(detail.retro_dismissed, 1);

  // Run 3: already healed — the count must not repeat (idempotency).
  const third = await runSync(deps);
  assertEquals(third.detail.retro_dismissed, 0);
});

Deno.test("self-heal never touches a MATCHED row, even if its event became a chore (issue #84)", async () => {
  const { deps, sessions } = makeDb({
    events: [{
      id: "ev-matched",
      summary: "Cita real de prueba",
      start: { dateTime: "2026-07-27T12:00:00-03:00" },
      end: { dateTime: "2026-07-27T13:00:00-03:00" },
    }] as RawEvent[],
  });
  await runSync(deps);
  // A human resolved it in the app.
  sessions.get("ev-matched")!.client_id = "c-1";

  deps.fetchEvents = () =>
    Promise.resolve([{
      id: "ev-matched",
      summary: "VENCE UTE",
      start: { dateTime: "2026-07-27T12:00:00-03:00" },
      end: { dateTime: "2026-07-27T13:00:00-03:00" },
    }] as RawEvent[]);
  const { detail } = await runSync(deps);

  assertEquals(detail.retro_dismissed, 0);
  assertEquals(sessions.get("ev-matched")!.dismissed_at, null);
});

Deno.test("app-managed mirror events are NOT ingested as sessions (issue #119, §II.7)", async () => {
  // An event this app wrote (vaigApp marker) must never become a session in
  // the sync — the app session already exists in the DB. Re-ingesting it would
  // create a duplicate session for the same appointment and double the
  // reminder. This is the primary defense; the client|day dedup is secondary.
  const mirror: RawEvent = {
    id: "vaig3f2504e04f8941d39a0c0305e82c3301",
    summary: "Ada Inventada — depilacion",
    start: { dateTime: "2026-08-10T14:00:00-03:00" },
    end: { dateTime: "2026-08-10T15:00:00-03:00" },
    extendedProperties: { private: { vaigApp: "1", vaigSessionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" } },
  } as unknown as RawEvent;
  const plainManual: RawEvent = {
    id: "ma-plain-1",
    summary: "clienta inventada 15hs",
    start: { dateTime: "2026-08-10T15:00:00-03:00" },
    end: { dateTime: "2026-08-10T16:00:00-03:00" },
  } as unknown as RawEvent;

  const { deps, sessions } = makeDb({ events: [mirror, plainManual] });
  const { ok, detail } = await runSync(deps);

  assert(ok);
  // Only the plain manual event became a session; the mirror was discarded.
  assertEquals(sessions.size, 1);
  assertEquals([...sessions.values()][0].gcal_event_id, "ma-plain-1");
  const discarded = detail.discarded as Record<string, { count: number }>;
  assertEquals(discarded.app_managed.count, 1);
});

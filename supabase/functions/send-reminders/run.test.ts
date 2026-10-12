/**
 * Batch behavior tests for send-reminders (issue E4-T2 AC 1–3), against
 * fake deps — no network, no database. All personal data is invented.
 */
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import type { Candidate } from "./logic.ts";
import { type Deps, runSendReminders, type SendResult } from "./run.ts";

// 10:00 in Montevideo (UTC-3) on the 14th → the window is the NEXT local
// day, the 15th: [2026-07-15T03:00Z, 2026-07-16T03:00Z) (issue #78).
const NOW = new Date("2026-07-14T13:00:00Z");

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    id: "s-1",
    client_id: "c-1",
    starts_at: "2026-07-15T17:30:00Z", // mié 15/07 14:30 in Montevideo
    service: "maderoterapia",
    full_name: "Alba Inventada",
    phone: "+59891234567",
    ...over,
  };
}

type SendImpl = (payload: Record<string, unknown>) => Promise<SendResult>;

function makeDeps(opts: {
  candidates: Candidate[];
  reminded?: { client_id: string; starts_at: string }[];
  external?: { client_id: string; starts_at: string }[];
  sendImpl?: SendImpl;
  markImpl?: (sessionId: string, wamid: string) => Promise<void>;
}) {
  const calls = {
    sentPayloads: [] as Record<string, unknown>[],
    marked: [] as { sessionId: string; wamid: string }[],
    finished: null as null | { ok: boolean; detail: unknown },
    window: null as null | { from: string; to: string },
    onlySessionId: undefined as string | undefined,
  };
  const deps: Deps = {
    now: () => NOW,
    fetchCandidates: (from, to, onlySessionId) => {
      calls.window = { from, to };
      calls.onlySessionId = onlySessionId;
      return Promise.resolve(opts.candidates);
    },
    fetchReminded: () => Promise.resolve(opts.reminded ?? []),
    // Contract: the real adapter only returns SCHEDULED external rows.
    fetchExternalCovered: () => Promise.resolve(opts.external ?? []),
    sendTemplate: (payload) => {
      calls.sentPayloads.push(payload);
      return (opts.sendImpl ?? (() => Promise.resolve({ ok: true, wamid: `wamid-${calls.sentPayloads.length}` } as SendResult)))(payload);
    },
    markSent: (sessionId, wamid) => {
      if (opts.markImpl) return opts.markImpl(sessionId, wamid);
      calls.marked.push({ sessionId, wamid });
      return Promise.resolve();
    },
    startJobRun: () => Promise.resolve("job-1"),
    finishJobRun: (_id, ok, detail) => {
      calls.finished = { ok, detail };
      return Promise.resolve();
    },
  };
  return { deps, calls };
}

Deno.test("dry_run logs the selection and sends/marks nothing (AC 1)", async () => {
  const { deps, calls } = makeDeps({
    candidates: [
      candidate(),
      candidate({ id: "s-2", client_id: "c-2", phone: "+59899876543" }),
    ],
  });
  const result = await runSendReminders(deps, true);

  assert(result.ok);
  assertEquals(calls.sentPayloads.length, 0);
  assertEquals(calls.marked.length, 0);
  assertEquals(result.detail.sent, 0);
  const selected = result.detail.selected as { session_id: string; phone_last4: string }[];
  assertEquals(selected.map((s) => s.session_id), ["s-1", "s-2"]);
  assertEquals(selected[0].phone_last4, "4567");
  // job_runs.detail must never carry a full phone number.
  assertFalse(JSON.stringify(result.detail).includes("59891234567"));
  assertEquals(calls.finished?.ok, true);
});

Deno.test("selection window is the whole next Montevideo day (issue #78)", async () => {
  const { deps, calls } = makeDeps({ candidates: [] });
  await runSendReminders(deps, true);
  // Midnight-to-midnight in Montevideo (UTC-3), not now+24h/now+48h: a
  // 16:00 run must also catch tomorrow-MORNING sessions.
  assertEquals(calls.window, {
    from: "2026-07-15T03:00:00.000Z",
    to: "2026-07-16T03:00:00.000Z",
  });
});

Deno.test("late-evening run: UTC already rolled over, window still targets the Montevideo next day (issue #78)", async () => {
  const { deps, calls } = makeDeps({ candidates: [] });
  // 21:38 on the 23rd in Montevideo is 00:38Z on the 24th — the next LOCAL
  // day is the 24th, not the 25th.
  deps.now = () => new Date("2026-07-24T00:38:00Z");
  await runSendReminders(deps, true);
  assertEquals(calls.window, {
    from: "2026-07-24T03:00:00.000Z",
    to: "2026-07-25T03:00:00.000Z",
  });
});

Deno.test("Graph errors echoing the recipient are redacted before job_runs", async () => {
  const { deps } = makeDeps({
    candidates: [candidate()],
    sendImpl: () =>
      Promise.resolve({
        ok: false,
        error: 'HTTP 400: {"message":"Invalid recipient +59891234567"}',
      }),
  });
  const result = await runSendReminders(deps, false);

  const errors = result.detail.errors as { error: string }[];
  assert(errors[0].error.includes("***4567"));
  assertFalse(JSON.stringify(result.detail).includes("59891234567"));
});

Deno.test("one send failure does not stop the batch (AC 2)", async () => {
  const { deps, calls } = makeDeps({
    candidates: [
      candidate(),
      candidate({ id: "s-2", client_id: "c-2", phone: "+59899876543" }),
      candidate({ id: "s-3", client_id: "c-3", phone: "+59894445555" }),
    ],
    sendImpl: (payload) => {
      const to = (payload as { to: string }).to;
      if (to === "59899876543") {
        return Promise.resolve({ ok: false, error: "HTTP 400: invalid" });
      }
      return Promise.resolve({ ok: true, wamid: `wamid-${to.slice(-4)}` });
    },
  });
  const result = await runSendReminders(deps, false);

  assertFalse(result.ok);
  assertEquals(result.detail.sent, 2);
  assertEquals(calls.marked.map((m) => m.sessionId), ["s-1", "s-3"]);
  const errors = result.detail.errors as { session_id: string; phone_last4: string }[];
  assertEquals(errors.length, 1);
  assertEquals(errors[0].session_id, "s-2");
  assertEquals(errors[0].phone_last4, "6543");
  assertEquals(calls.finished?.ok, false);
});

Deno.test("a thrown send is accumulated too, batch continues (AC 2)", async () => {
  const { deps, calls } = makeDeps({
    candidates: [
      candidate(),
      candidate({ id: "s-2", client_id: "c-2", phone: "+59899876543" }),
    ],
    sendImpl: (payload) =>
      (payload as { to: string }).to === "59891234567"
        ? Promise.reject(new Error("network down"))
        : Promise.resolve({ ok: true, wamid: "wamid-ok" }),
  });
  const result = await runSendReminders(deps, false);

  assertFalse(result.ok);
  assertEquals(result.detail.sent, 1);
  assertEquals(calls.marked.map((m) => m.sessionId), ["s-2"]);
  assertEquals((result.detail.errors as unknown[]).length, 1);
});

Deno.test("one reminder per client per Montevideo day (AC 3)", async () => {
  const { deps, calls } = makeDeps({
    candidates: [
      // Same client, same local day (External + manual duplicate): the later
      // one must be skipped.
      candidate({ id: "s-late", starts_at: "2026-07-15T20:00:00Z" }),
      candidate({ id: "s-early", starts_at: "2026-07-15T17:30:00Z" }),
      // Different client whose OTHER session the same local day was already
      // reminded: skipped without sending.
      candidate({
        id: "s-other",
        client_id: "c-2",
        phone: "+59899876543",
        starts_at: "2026-07-15T18:00:00Z",
      }),
    ],
    reminded: [{ client_id: "c-2", starts_at: "2026-07-15T12:00:00Z" }],
  });
  const result = await runSendReminders(deps, false);

  assert(result.ok);
  assertEquals(calls.marked.map((m) => m.sessionId), ["s-early"]);
  const skipped = result.detail.skipped_dedup as { session_id: string; reason: string }[];
  assertEquals(
    new Map(skipped.map((s) => [s.session_id, s.reason])),
    new Map([
      ["s-late", "duplicate_in_batch"],
      ["s-other", "already_reminded_same_day"],
    ]),
  );
});

Deno.test("UTC/local day mismatch: dedup keys on the Montevideo day (AC 3)", async () => {
  // 02:00Z on the 16th is 23:00 on the 15th in Montevideo — same local day
  // as 17:30Z on the 15th, so only one reminder goes out.
  const { deps, calls } = makeDeps({
    candidates: [
      candidate({ id: "s-a", starts_at: "2026-07-15T17:30:00Z" }),
      candidate({ id: "s-b", starts_at: "2026-07-16T02:00:00Z" }),
    ],
  });
  const result = await runSendReminders(deps, false);

  assert(result.ok);
  assertEquals(calls.marked.map((m) => m.sessionId), ["s-a"]);
  assertEquals(
    (result.detail.skipped_dedup as { session_id: string }[])[0].session_id,
    "s-b",
  );
});

Deno.test("sent-but-unmarked is surfaced as an error (double-send guard)", async () => {
  const { deps } = makeDeps({
    candidates: [candidate()],
    markImpl: () => Promise.reject(new Error("db unavailable")),
  });
  const result = await runSendReminders(deps, false);

  assertFalse(result.ok);
  assertEquals(result.detail.sent, 1);
  const errors = result.detail.errors as { error: string; wamid?: string }[];
  assert(errors[0].error.includes("sent but failed to mark"));
  assertEquals(errors[0].wamid, "wamid-1");
});

Deno.test("a fatal error still closes the job_runs row", async () => {
  const { deps, calls } = makeDeps({ candidates: [] });
  deps.fetchCandidates = () => Promise.reject(new Error("boom"));
  const result = await runSendReminders(deps, false);

  assertFalse(result.ok);
  assert(String(result.detail.fatal).includes("boom"));
  assertEquals(calls.finished?.ok, false);
});

Deno.test("template payload carries the session-scoped button payloads", async () => {
  const { deps, calls } = makeDeps({ candidates: [candidate()] });
  await runSendReminders(deps, false);

  const template = (calls.sentPayloads[0] as {
    template: { name: string; language: { code: string }; components: unknown[] };
  }).template;
  assertEquals(template.name, "recordatorio_sesion");
  assertEquals(template.language.code, "es_UY");
  const buttons = (template.components as {
    type: string;
    parameters?: { payload?: string }[];
  }[]).filter((c) => c.type === "button");
  assertEquals(buttons.map((b) => b.parameters?.[0].payload), [
    "CONFIRM_s-1",
    "RESCHED_s-1",
  ]);
});

Deno.test("rehearsal override redirects every send, marks the real session, and stamps the audit row (issue #60)", async () => {
  const { deps, calls } = makeDeps({
    candidates: [
      candidate(),
      candidate({ id: "s-2", client_id: "c-2", starts_at: "2026-07-15T20:00:00Z", phone: "+59899876543" }),
    ],
  });
  const result = await runSendReminders(deps, false, "+59891234510");

  assert(result.ok);
  assertEquals(result.detail.test_override, true);
  assertEquals(calls.sentPayloads.length, 2);
  for (const p of calls.sentPayloads) {
    assertEquals((p as { to: string }).to, "59891234510");
  }
  // The REAL sessions get marked — the rehearsal is faithful to production.
  assertEquals(calls.marked.map((m) => m.sessionId), ["s-1", "s-2"]);
});

Deno.test("malformed override aborts fatally with zero sends (issue #60)", async () => {
  const { deps, calls } = makeDeps({ candidates: [candidate()] });
  const result = await runSendReminders(deps, false, "091234500");

  assertFalse(result.ok);
  assert(String(result.detail.fatal).includes("TEST_PHONE_OVERRIDE"));
  assertEquals(calls.sentPayloads.length, 0);
  assertEquals(calls.marked.length, 0);
  assertEquals(calls.finished?.ok, false);
});

Deno.test("no override → no test_override stamp in the audit row (issue #60)", async () => {
  const { deps } = makeDeps({ candidates: [candidate()] });
  const result = await runSendReminders(deps, false);
  assert(result.ok);
  assertEquals("test_override" in result.detail, false);
});

Deno.test("dry_run + override: still labeled, still sends nothing (issue #60)", async () => {
  const { deps, calls } = makeDeps({ candidates: [candidate()] });
  const result = await runSendReminders(deps, true, "+59891234510");
  assert(result.ok);
  assertEquals(result.detail.test_override, true);
  assertEquals(calls.sentPayloads.length, 0);
});

Deno.test("external booking same Montevideo day suppresses the manual twin (issue #69)", async () => {
  const { deps, calls } = makeDeps({
    candidates: [candidate()], // manual, 2026-07-15T17:30Z = 15/07 14:30 MVD
    external: [{ client_id: "c-1", starts_at: "2026-07-15T17:30:00Z" }],
  });
  const result = await runSendReminders(deps, false);

  assert(result.ok);
  assertEquals(calls.sentPayloads.length, 0);
  const skipped = result.detail.skipped_dedup as { reason: string }[];
  assertEquals(skipped[0].reason, "external_covers_same_day");
});

Deno.test("external booking on ANOTHER day does not suppress (issue #69)", async () => {
  const { deps, calls } = makeDeps({
    candidates: [candidate()],
    // 16/07 in Montevideo — different day key than the 15/07 candidate.
    external: [{ client_id: "c-1", starts_at: "2026-07-16T17:30:00Z" }],
  });
  const result = await runSendReminders(deps, false);

  assert(result.ok);
  assertEquals(calls.sentPayloads.length, 1);
});

Deno.test("external coverage keys on the Montevideo day, not the UTC day (issue #69)", async () => {
  // Candidate 2026-07-16T01:00Z = 15/07 22:00 in Montevideo. A external row
  // at 15/07 14:30 MVD shares the LOCAL day even though UTC days differ.
  const { deps, calls } = makeDeps({
    candidates: [candidate({ starts_at: "2026-07-16T01:00:00Z" })],
    external: [{ client_id: "c-1", starts_at: "2026-07-15T17:30:00Z" }],
  });
  const result = await runSendReminders(deps, false);

  assertEquals(calls.sentPayloads.length, 0);
  const skipped = result.detail.skipped_dedup as { reason: string }[];
  assertEquals(skipped[0].reason, "external_covers_same_day");
});

Deno.test("immediate scope: onlySessionId is threaded to fetchCandidates (issue #120)", async () => {
  const { deps, calls } = makeDeps({ candidates: [candidate({ id: "sess-imm", client_id: "c-1" })] });
  const result = await runSendReminders(deps, false, undefined, "sess-imm");

  assert(result.ok);
  // The single-session scope reaches the predicate, and detail records it.
  assertEquals(calls.onlySessionId, "sess-imm");
  assertEquals((result.detail.scope as { only_session: string }).only_session, "sess-imm");
  // Still sends exactly the one candidate through the normal pipeline.
  assertEquals(calls.marked.map((m) => m.sessionId), ["sess-imm"]);
});

Deno.test("immediate scope survives a midnight-crossing exec: the session is still sent even though its day is outside now's window (issue #120)", async () => {
  // The bug this guards: needsImmediateReminder ran at CRUD time (day X 23:59),
  // but the edge fn executes at day X+1 00:00, so nextLocalDayWindow(now) is
  // now [X+2, X+3) — the target (X+1) sits OUTSIDE it. A window-respecting
  // predicate would return 0 rows. The immediate path must ignore the window.
  const targetStarts = "2026-07-16T13:00:00Z"; // day X+1, 10:00 MVD
  const windowRespectingDeps = () => {
    const { deps, calls } = makeDeps({ candidates: [candidate({ id: "sess-mid", client_id: "c-1", starts_at: targetStarts })] });
    // Exec time = day X+1 00:00 MVD (03:00Z) → window would be [X+2, X+3).
    deps.now = () => new Date("2026-07-16T03:00:00Z");
    // Make the fake HONOR the window like the real adapter, EXCEPT when scoped
    // by id (which is the fix: id bypasses the window).
    deps.fetchCandidates = (from, to, onlySessionId) => {
      calls.window = { from, to };
      calls.onlySessionId = onlySessionId;
      if (onlySessionId) return Promise.resolve([candidate({ id: "sess-mid", client_id: "c-1", starts_at: targetStarts })]);
      const t = new Date(targetStarts).getTime();
      const inWindow = t >= new Date(from).getTime() && t < new Date(to).getTime();
      return Promise.resolve(inWindow ? [candidate({ id: "sess-mid", client_id: "c-1", starts_at: targetStarts })] : []);
    };
    return { deps, calls };
  };
  const { deps, calls } = windowRespectingDeps();
  const result = await runSendReminders(deps, false, undefined, "sess-mid");

  assert(result.ok);
  // Despite the target sitting outside now's window, the id-scoped path sends it.
  assertEquals(calls.marked.map((m) => m.sessionId), ["sess-mid"]);
});

Deno.test("batch scope: no onlySessionId → scope is 'batch' (issue #120)", async () => {
  const { deps, calls } = makeDeps({ candidates: [] });
  const result = await runSendReminders(deps, false);
  assertEquals(calls.onlySessionId, undefined);
  assertEquals(result.detail.scope, "batch");
});

/**
 * Batch behavior tests for send-review-requests (PRD §III, layer 3), against
 * fake deps — no network, no database. All personal data is invented.
 */
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import type { ReviewCandidate } from "./logic.ts";
import { type Deps, runSendReviewRequests, type SendResult } from "./run.ts";

const NOW = new Date("2026-08-11T12:00:00Z"); // 09:00 Montevideo

function candidate(over: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    client_id: "c-1",
    full_name: "Gabriela Inventada",
    phone: "+59891234567",
    last_completed_at: "2026-08-10T18:00:00Z",
    ...over,
  };
}

type SendImpl = (payload: Record<string, unknown>) => Promise<SendResult>;

function makeDeps(opts: {
  candidates: ReviewCandidate[];
  sendImpl?: SendImpl;
  markImpl?: (clientId: string) => Promise<void>;
}) {
  const calls = {
    sentPayloads: [] as Record<string, unknown>[],
    marked: [] as string[],
    finished: null as null | { ok: boolean; detail: unknown },
    window: null as null | { from: string; to: string },
  };
  const deps: Deps = {
    now: () => NOW,
    fetchCandidates: (from, to) => {
      calls.window = { from, to };
      return Promise.resolve(opts.candidates);
    },
    sendTemplate: (payload) => {
      calls.sentPayloads.push(payload);
      return (opts.sendImpl ??
        (() =>
          Promise.resolve(
            { ok: true, wamid: `wamid-${calls.sentPayloads.length}` } as SendResult,
          )))(payload);
    },
    markRequested: (clientId) => {
      if (opts.markImpl) return opts.markImpl(clientId);
      calls.marked.push(clientId);
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

Deno.test("sends to each candidate and marks the client requested", async () => {
  const { deps, calls } = makeDeps({
    candidates: [candidate({ client_id: "c-1" }), candidate({ client_id: "c-2" })],
  });
  const out = await runSendReviewRequests(deps, false);
  assert(out.ok);
  assertEquals(calls.sentPayloads.length, 2);
  assertEquals(calls.marked, ["c-1", "c-2"]);
  assertEquals((out.detail as { sent: number }).sent, 2);
});

Deno.test("the window passed to fetch is yesterday's Montevideo day", async () => {
  const { deps, calls } = makeDeps({ candidates: [] });
  await runSendReviewRequests(deps, false);
  assertEquals(calls.window, {
    from: "2026-08-10T03:00:00.000Z",
    to: "2026-08-11T03:00:00.000Z",
  });
});

Deno.test("one send failure does not abort the batch", async () => {
  // First send fails, second succeeds — distinguish by call order.
  let n = 0;
  const { deps, calls } = makeDeps({
    candidates: [candidate({ client_id: "c-1" }), candidate({ client_id: "c-2" })],
    sendImpl: () => {
      n++;
      return Promise.resolve(
        n === 1
          ? { ok: false, error: "HTTP 400" }
          : { ok: true, wamid: "w2" },
      );
    },
  });
  const out = await runSendReviewRequests(deps, false);
  assertFalse(out.ok); // errors present → not ok
  assertEquals((out.detail as { sent: number }).sent, 1); // the second still sent
  assertEquals(calls.marked, ["c-2"]); // only the successful one marked
});

Deno.test("does NOT mark a client whose send failed (no double-ask risk)", async () => {
  const { deps, calls } = makeDeps({
    candidates: [candidate({ client_id: "c-1" })],
    sendImpl: () => Promise.resolve({ ok: false, error: "HTTP 500" }),
  });
  const out = await runSendReviewRequests(deps, false);
  assertFalse(out.ok);
  assertEquals(calls.marked, []); // unsent → unmarked → still a candidate tomorrow
});

Deno.test("'sent but failed to mark' is surfaced as an error", async () => {
  const { deps } = makeDeps({
    candidates: [candidate({ client_id: "c-1" })],
    markImpl: () => Promise.reject(new Error("db down")),
  });
  const out = await runSendReviewRequests(deps, false);
  assertFalse(out.ok);
  const errors = (out.detail as { errors: { error: string }[] }).errors;
  assertEquals(errors.length, 1);
  assert(errors[0].error.includes("sent but failed to mark"));
});

Deno.test("dry_run selects but never sends or marks", async () => {
  const { deps, calls } = makeDeps({ candidates: [candidate()] });
  const out = await runSendReviewRequests(deps, true);
  assert(out.ok);
  assertEquals(calls.sentPayloads.length, 0);
  assertEquals(calls.marked, []);
  assertEquals((out.detail as { sent: number }).sent, 0);
});

Deno.test("a malformed rehearsal override aborts before any send", async () => {
  const { deps, calls } = makeDeps({ candidates: [candidate()] });
  const out = await runSendReviewRequests(deps, false, "not-a-phone");
  assertFalse(out.ok);
  assertEquals(calls.sentPayloads.length, 0);
  assert((out.detail as { fatal: string }).fatal.includes("E.164"));
});

Deno.test("a valid rehearsal override sends to the override, not the client", async () => {
  const { deps, calls } = makeDeps({ candidates: [candidate()] });
  const out = await runSendReviewRequests(deps, false, "+59899999999");
  assert(out.ok);
  assertEquals((calls.sentPayloads[0] as { to: string }).to, "59899999999");
});

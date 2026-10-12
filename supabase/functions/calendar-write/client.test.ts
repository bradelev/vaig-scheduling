/**
 * HTTP-contract tests for calendar-write's Google I/O (issue #118), with a
 * stubbed `fetch`. This is the layer where the insert-vs-update semantics
 * live — a PUT-does-not-create bug slipped through before precisely because
 * this contract was untested. All data invented.
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { deleteMirror, upsertMirror } from "./client.ts";
import type { MirrorSession } from "./logic.ts";

const CAL = "cal@example.com";
const TOKEN = "test-token";
const SESSION: MirrorSession = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  starts_at: "2026-08-10T17:00:00.000Z",
  ends_at: "2026-08-10T18:00:00.000Z",
  client_name: "Alba Inventada",
  service: "hifu",
};

type FetchCall = { url: string; method: string; body?: string };

function stubFetch(responder: (call: FetchCall) => Response): {
  calls: FetchCall[];
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body as string | undefined,
    };
    calls.push(call);
    return Promise.resolve(responder(call));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = orig) };
}

Deno.test("create uses events.insert (POST /events), not PUT — the core fix", async () => {
  const f = stubFetch(() => new Response("{}", { status: 200 }));
  try {
    const id = await upsertMirror(TOKEN, CAL, SESSION, "create");
    assertEquals(f.calls.length, 1);
    assertEquals(f.calls[0].method, "POST");
    assertEquals(f.calls[0].url.endsWith("/events"), true); // collection, not /{id}
    assertEquals(id, "vaig3f2504e04f8941d39a0c0305e82c3301");
  } finally {
    f.restore();
  }
});

Deno.test("a retried create (409 already exists) falls back to PUT and succeeds", async () => {
  const f = stubFetch((c) =>
    c.method === "POST"
      ? new Response("exists", { status: 409 })
      : new Response("{}", { status: 200 })
  );
  try {
    const id = await upsertMirror(TOKEN, CAL, SESSION, "create");
    assertEquals(f.calls.map((c) => c.method), ["POST", "PUT"]);
    assertEquals(f.calls[1].url.endsWith("vaig3f2504e04f8941d39a0c0305e82c3301"), true);
    assertEquals(id, "vaig3f2504e04f8941d39a0c0305e82c3301");
  } finally {
    f.restore();
  }
});

Deno.test("op=update goes straight to PUT /events/{id}", async () => {
  const f = stubFetch(() => new Response("{}", { status: 200 }));
  try {
    await upsertMirror(TOKEN, CAL, SESSION, "update");
    assertEquals(f.calls.length, 1);
    assertEquals(f.calls[0].method, "PUT");
  } finally {
    f.restore();
  }
});

Deno.test("a non-409 insert error throws (surfaced to keep the session mirror-pending)", async () => {
  const f = stubFetch(() => new Response("boom", { status: 500 }));
  try {
    await assertRejects(() => upsertMirror(TOKEN, CAL, SESSION, "create"));
  } finally {
    f.restore();
  }
});

Deno.test("delete tolerates 404/410 (already gone = success)", async () => {
  for (const status of [200, 404, 410]) {
    const f = stubFetch(() => new Response("", { status }));
    try {
      await deleteMirror(TOKEN, CAL, SESSION.id); // must not throw
      assertEquals(f.calls[0].method, "DELETE");
    } finally {
      f.restore();
    }
  }
});

Deno.test("delete throws on a real error (e.g. 403)", async () => {
  const f = stubFetch(() => new Response("nope", { status: 403 }));
  try {
    await assertRejects(() => deleteMirror(TOKEN, CAL, SESSION.id));
  } finally {
    f.restore();
  }
});

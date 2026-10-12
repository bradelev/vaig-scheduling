/**
 * Handler wiring tests for wa-webhook (issue E5-T1): the security-critical
 * request flow — signature gate, GET verification, button → correct write,
 * free-text no-op, DB error → 500. Fake applyAction, real HMAC.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Config, handleRequest } from "./index.ts";
import type { ButtonAction } from "./logic.ts";

const VERIFY_TOKEN = "verify-token-invented";
const APP_SECRET = "app-secret-invented";

async function sign(rawBody: string, secret = APP_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)),
  );
  return "sha256=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function buttonBody(payload: string): string {
  return JSON.stringify({
    entry: [{
      changes: [{
        value: { messages: [{ type: "button", button: { payload } }] },
      }],
    }],
  });
}

function testConfig(over: Partial<Config> = {}): {
  cfg: Config;
  applied: ButtonAction[];
} {
  const applied: ButtonAction[] = [];
  const cfg: Config = {
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    applyAction: (a) => {
      applied.push(a);
      return Promise.resolve();
    },
    ...over,
  };
  return { cfg, applied };
}

const post = (raw: string, sig: string | null) =>
  new Request("https://x/wa-webhook", {
    method: "POST",
    headers: sig ? { "x-hub-signature-256": sig } : {},
    body: raw,
  });

Deno.test("GET returns the challenge when the token matches (AC 1)", async () => {
  const { cfg } = testConfig();
  const req = new Request(
    `https://x/wa-webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=CHAL123`,
  );
  const res = await handleRequest(req, cfg);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/plain");
  assertEquals(await res.text(), "CHAL123");
});

Deno.test("GET with a wrong token is forbidden and does not echo (AC 1)", async () => {
  const { cfg } = testConfig();
  const req = new Request(
    "https://x/wa-webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHAL123",
  );
  const res = await handleRequest(req, cfg);
  assertEquals(res.status, 403);
  assert(!(await res.text()).includes("CHAL123"));
});

Deno.test("POST with an invalid signature is rejected with 401 (AC 2)", async () => {
  const { cfg, applied } = testConfig();
  const raw = buttonBody("CONFIRM_sess-1");
  const res = await handleRequest(post(raw, "sha256=deadbeef"), cfg);
  assertEquals(res.status, 401);
  assertEquals(applied.length, 0); // never reached the DB
});

Deno.test("POST with no signature header is rejected with 401 (AC 2)", async () => {
  const { cfg } = testConfig();
  const res = await handleRequest(post(buttonBody("CONFIRM_sess-1"), null), cfg);
  assertEquals(res.status, 401);
});

Deno.test("a valid CONFIRM applies a confirm action (AC 3)", async () => {
  const { cfg, applied } = testConfig();
  const raw = buttonBody("CONFIRM_sess-42");
  const res = await handleRequest(post(raw, await sign(raw)), cfg);
  assertEquals(res.status, 200);
  assertEquals(applied, [{ kind: "confirm", sessionId: "sess-42" }]);
});

Deno.test("a valid RESCHED applies a reschedule action (AC 3)", async () => {
  const { cfg, applied } = testConfig();
  const raw = buttonBody("RESCHED_sess-99");
  const res = await handleRequest(post(raw, await sign(raw)), cfg);
  assertEquals(res.status, 200);
  assertEquals(applied, [{ kind: "reschedule", sessionId: "sess-99" }]);
});

Deno.test("a signed free-text message returns 200 with no side effect (AC 4)", async () => {
  const { cfg, applied } = testConfig();
  const raw = JSON.stringify({
    entry: [{
      changes: [{
        value: { messages: [{ type: "text", text: { body: "hola" } }] },
      }],
    }],
  });
  const res = await handleRequest(post(raw, await sign(raw)), cfg);
  assertEquals(res.status, 200);
  assertEquals(applied.length, 0);
});

Deno.test("a signed-but-unparseable body returns 200 no-op", async () => {
  const { cfg, applied } = testConfig();
  const raw = "not json{";
  const res = await handleRequest(post(raw, await sign(raw)), cfg);
  assertEquals(res.status, 200);
  assertEquals(applied.length, 0);
});

Deno.test("a DB failure surfaces as 500 so Meta retries (R1)", async () => {
  const { cfg } = testConfig({
    applyAction: () => Promise.reject(new Error("db down")),
  });
  const raw = buttonBody("CONFIRM_sess-1");
  const res = await handleRequest(post(raw, await sign(raw)), cfg);
  assertEquals(res.status, 500);
});

Deno.test("the signature is checked BEFORE any apply (invalid sig never applies)", async () => {
  const { cfg, applied } = testConfig({
    applyAction: () => Promise.reject(new Error("should never run")),
  });
  const raw = buttonBody("CONFIRM_sess-1");
  const res = await handleRequest(post(raw, "sha256=00"), cfg);
  assertEquals(res.status, 401);
  assertEquals(applied.length, 0);
});

Deno.test("RESCHED fires onReschedule with the session id (issue #62)", async () => {
  const pinged: string[] = [];
  const { cfg } = testConfig({
    onReschedule: (id) => {
      pinged.push(id);
      return Promise.resolve();
    },
  });
  const raw = buttonBody("RESCHED_sess-9");
  const res = await handleRequest(post(raw, await sign(raw)), cfg);
  assertEquals(res.status, 200);
  assertEquals(pinged, ["sess-9"]);
});

Deno.test("CONFIRM never fires onReschedule (issue #62)", async () => {
  const pinged: string[] = [];
  const { cfg, applied } = testConfig({
    onReschedule: (id) => {
      pinged.push(id);
      return Promise.resolve();
    },
  });
  const raw = buttonBody("CONFIRM_sess-1");
  const res = await handleRequest(post(raw, await sign(raw)), cfg);
  assertEquals(res.status, 200);
  assertEquals(applied.length, 1);
  assertEquals(pinged, []);
});

Deno.test("a failing onReschedule never changes the response — the action already applied (issue #62)", async () => {
  const { cfg, applied } = testConfig({
    onReschedule: () => Promise.reject(new Error("whatsapp down")),
  });
  const raw = buttonBody("RESCHED_sess-9");
  const res = await handleRequest(post(raw, await sign(raw)), cfg);
  assertEquals(res.status, 200); // NOT 500: a Meta retry would re-ping, not fix anything
  assertEquals(applied.length, 1);
});

Deno.test("CONFIRM fires onConfirm with the session id (issue #68)", async () => {
  const acked: string[] = [];
  const { cfg } = testConfig({
    onConfirm: (id) => {
      acked.push(id);
      return Promise.resolve();
    },
  });
  const raw = buttonBody("CONFIRM_sess-7");
  const res = await handleRequest(post(raw, await sign(raw)), cfg);
  assertEquals(res.status, 200);
  assertEquals(acked, ["sess-7"]);
});

Deno.test("RESCHED never fires onConfirm, CONFIRM never fires onReschedule (issue #68)", async () => {
  const acked: string[] = [];
  const pinged: string[] = [];
  const { cfg } = testConfig({
    onConfirm: (id) => {
      acked.push(id);
      return Promise.resolve();
    },
    onReschedule: (id) => {
      pinged.push(id);
      return Promise.resolve();
    },
  });
  const raw = buttonBody("RESCHED_sess-8");
  await handleRequest(post(raw, await sign(raw)), cfg);
  assertEquals(acked, []);
  assertEquals(pinged, ["sess-8"]);
});

Deno.test("a failing onConfirm never changes the response (issue #68)", async () => {
  const { cfg, applied } = testConfig({
    onConfirm: () => Promise.reject(new Error("whatsapp down")),
  });
  const raw = buttonBody("CONFIRM_sess-7");
  const res = await handleRequest(post(raw, await sign(raw)), cfg);
  assertEquals(res.status, 200);
  assertEquals(applied.length, 1);
});

function textBody(from: string): string {
  return JSON.stringify({
    entry: [{
      changes: [{ value: { messages: [{ type: "text", from, text: { body: "hola" } }] } }],
    }],
  });
}

Deno.test("free text fires onFreeText with the sender (issue #74)", async () => {
  const redirected: string[] = [];
  const { cfg, applied } = testConfig({
    onFreeText: (p) => {
      redirected.push(p);
      return Promise.resolve();
    },
  });
  const raw = textBody("59891234567");
  const res = await handleRequest(post(raw, await sign(raw)), cfg);
  assertEquals(res.status, 200);
  assertEquals(applied.length, 0);
  assertEquals(redirected, ["59891234567"]);
});

Deno.test("button taps never fire onFreeText (issue #74)", async () => {
  const redirected: string[] = [];
  const { cfg } = testConfig({
    onFreeText: (p) => {
      redirected.push(p);
      return Promise.resolve();
    },
  });
  const raw = buttonBody("CONFIRM_sess-1");
  await handleRequest(post(raw, await sign(raw)), cfg);
  assertEquals(redirected, []);
});

Deno.test("a failing onFreeText never changes the response (issue #74)", async () => {
  const { cfg } = testConfig({
    onFreeText: () => Promise.reject(new Error("whatsapp down")),
  });
  const raw = textBody("59891234567");
  const res = await handleRequest(post(raw, await sign(raw)), cfg);
  assertEquals(res.status, 200);
});

Deno.test("no onFreeText wired (SHOP_WHATSAPP unset) → free text is a silent 200 (issue #74)", async () => {
  const { cfg, applied } = testConfig();
  const raw = textBody("59891234567");
  const res = await handleRequest(post(raw, await sign(raw)), cfg);
  assertEquals(res.status, 200);
  assertEquals(applied.length, 0);
});

Deno.test("unsigned free text never reaches onFreeText (issue #74)", async () => {
  const redirected: string[] = [];
  const { cfg } = testConfig({
    onFreeText: (p) => {
      redirected.push(p);
      return Promise.resolve();
    },
  });
  const res = await handleRequest(post(textBody("59891234567"), null), cfg);
  assertEquals(res.status, 401);
  assertEquals(redirected, []);
});

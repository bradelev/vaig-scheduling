/**
 * Tests for wa-webhook parsing + signature logic (issue E5-T1). The HMAC is
 * exercised for real via WebCrypto. Invented ids/secrets only.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ackRecipient,
  botRedirectMessage,
  type ButtonAction,
  confirmAckMessage,
  parseButtonActions,
  parseRedirectSenders,
  payloadToAction,
  RESCHED_ACK_MESSAGE,
  shouldReply,
  verifySignature,
} from "./logic.ts";

const APP_SECRET = "test-app-secret-invented";

/** Build a valid sha256= header for a body, the way Meta signs it. */
async function sign(rawBody: string, secret: string): Promise<string> {
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
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

function buttonPayload(payload: string) {
  return {
    entry: [{
      changes: [{
        value: { messages: [{ type: "button", button: { payload } }] },
      }],
    }],
  };
}

Deno.test("payloadToAction maps CONFIRM_/RESCHED_ and ignores others", () => {
  assertEquals(payloadToAction("CONFIRM_abc-123"), {
    kind: "confirm",
    sessionId: "abc-123",
  });
  assertEquals(payloadToAction("RESCHED_def-456"), {
    kind: "reschedule",
    sessionId: "def-456",
  });
  assertEquals(payloadToAction("SOMETHING_ELSE"), null);
  assertEquals(payloadToAction(""), null);
});

Deno.test("parseButtonActions extracts a confirm action (AC 3)", () => {
  const actions = parseButtonActions(buttonPayload("CONFIRM_sess-1"));
  assertEquals(actions, [{ kind: "confirm", sessionId: "sess-1" }] as ButtonAction[]);
});

Deno.test("parseButtonActions extracts a reschedule action (AC 3)", () => {
  const actions = parseButtonActions(buttonPayload("RESCHED_sess-2"));
  assertEquals(actions, [{ kind: "reschedule", sessionId: "sess-2" }] as ButtonAction[]);
});

Deno.test("free-text message yields no actions (AC 4)", () => {
  const body = {
    entry: [{
      changes: [{
        value: { messages: [{ type: "text", text: { body: "hola" } }] },
      }],
    }],
  };
  assertEquals(parseButtonActions(body), []);
});

Deno.test("delivery-status callbacks yield no actions (AC 4)", () => {
  const body = {
    entry: [{ changes: [{ value: { statuses: [{ status: "delivered" }] } }] }],
  };
  assertEquals(parseButtonActions(body), []);
});

Deno.test("malformed payloads never throw", () => {
  assertEquals(parseButtonActions(null), []);
  assertEquals(parseButtonActions({}), []);
  assertEquals(parseButtonActions({ entry: "nope" }), []);
  assertEquals(parseButtonActions({ entry: [{ changes: [{}] }] }), []);
});

Deno.test("verifySignature accepts a correctly signed body (AC 2)", async () => {
  const raw = JSON.stringify(buttonPayload("CONFIRM_sess-1"));
  const header = await sign(raw, APP_SECRET);
  assert(await verifySignature(raw, header, APP_SECRET));
});

Deno.test("verifySignature rejects a tampered body (AC 2)", async () => {
  const raw = JSON.stringify(buttonPayload("CONFIRM_sess-1"));
  const header = await sign(raw, APP_SECRET);
  const tampered = JSON.stringify(buttonPayload("CONFIRM_sess-EVIL"));
  assertEquals(await verifySignature(tampered, header, APP_SECRET), false);
});

Deno.test("verifySignature rejects a wrong secret (AC 2)", async () => {
  const raw = JSON.stringify(buttonPayload("CONFIRM_sess-1"));
  const header = await sign(raw, "attacker-secret");
  assertEquals(await verifySignature(raw, header, APP_SECRET), false);
});

Deno.test("verifySignature rejects missing/malformed headers (AC 2)", async () => {
  const raw = "{}";
  assertEquals(await verifySignature(raw, null, APP_SECRET), false);
  assertEquals(await verifySignature(raw, "", APP_SECRET), false);
  assertEquals(await verifySignature(raw, "md5=abcd", APP_SECRET), false);
  assertEquals(await verifySignature(raw, "sha256=nothex", APP_SECRET), false);
  assertEquals(await verifySignature(raw, "sha256=abc", APP_SECRET), false); // odd length
});

Deno.test("verifySignature rejects when app secret is unset", async () => {
  const raw = "{}";
  // A valid-looking header signed with some secret must still be rejected
  // when the function has no configured secret (fail closed).
  const header = await sign(raw, "some-secret");
  assertEquals(await verifySignature(raw, header, ""), false);
});

Deno.test("multiple button messages in one payload all parse", () => {
  const body = {
    entry: [{
      changes: [{
        value: {
          messages: [
            { type: "button", button: { payload: "CONFIRM_a" } },
            { type: "text", text: { body: "gracias" } },
            { type: "button", button: { payload: "RESCHED_b" } },
          ],
        },
      }],
    }],
  };
  assertEquals(parseButtonActions(body), [
    { kind: "confirm", sessionId: "a" },
    { kind: "reschedule", sessionId: "b" },
  ] as ButtonAction[]);
});

Deno.test("ackRecipient: rehearsal override always wins (issue #66)", () => {
  assertEquals(ackRecipient("+59891234567", "+59898000001"), "+59898000001");
});

Deno.test("ackRecipient: no override → client phone (issue #66)", () => {
  assertEquals(ackRecipient("+59891234567", undefined), "+59891234567");
});

Deno.test("ackRecipient: empty-string override counts as unset (issue #66)", () => {
  assertEquals(ackRecipient("+59891234567", ""), "+59891234567");
});

Deno.test("ackRecipient: nobody safe to message → null (issue #66)", () => {
  assertEquals(ackRecipient(null, undefined), null);
  assertEquals(ackRecipient("", undefined), null);
});

Deno.test("RESCHED_ACK_MESSAGE is a fixed sentence with no placeholders (issue #66)", () => {
  assertEquals(RESCHED_ACK_MESSAGE.includes("{"), false);
  assertEquals(RESCHED_ACK_MESSAGE.length > 20, true);
});

Deno.test("ackRecipient: malformed override sends to NOBODY, never the client (issue #66)", () => {
  assertEquals(ackRecipient("+59891234567", "no-es-telefono"), null);
  assertEquals(ackRecipient("+59891234567", "   "), null);
  assertEquals(ackRecipient("+59891234567", "091234500"), null);
});

Deno.test("confirmAckMessage interpolates date and time (issue #68)", () => {
  assertEquals(
    confirmAckMessage("jue 23/07", "18:30"),
    "¡Gracias por confirmar! 🌸 Te esperamos el jue 23/07 a las 18:30.",
  );
});

Deno.test("parseRedirectSenders: free text yields the sender, buttons never do (issue #74)", () => {
  const body = {
    entry: [{
      changes: [{
        value: {
          messages: [
            { type: "text", from: "59891234567", text: { body: "hola puedo ir a las 16?" } },
            { type: "button", from: "59899876543", button: { payload: "CONFIRM_x" } },
            { type: "audio", from: "59894445555" },
          ],
        },
      }],
    }],
  };
  assertEquals(parseRedirectSenders(body), ["59891234567", "59894445555"]);
});

Deno.test("parseRedirectSenders: statuses/malformed yield nothing, senders dedupe (issue #74)", () => {
  assertEquals(parseRedirectSenders(null), []);
  assertEquals(parseRedirectSenders({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] }), []);
  const twice = {
    entry: [{
      changes: [{
        value: {
          messages: [
            { type: "text", from: "59891234567" },
            { type: "image", from: "59891234567" },
          ],
        },
      }],
    }],
  };
  assertEquals(parseRedirectSenders(twice), ["59891234567"]);
});

Deno.test("shouldReply: first contact yes, inside 24h no, after 24h yes (issue #74)", () => {
  const now = Date.parse("2026-07-23T12:00:00Z");
  assertEquals(shouldReply(null, now), true);
  assertEquals(shouldReply("2026-07-23T11:00:00Z", now), false);
  assertEquals(shouldReply("2026-07-22T12:00:00Z", now), true); // exactly 24h
  assertEquals(shouldReply("not-a-date", now), true); // corrupt row never silences forever
});

Deno.test("botRedirectMessage builds the wa.me link from the E.164 (issue #74)", () => {
  const msg = botRedirectMessage("+59891112233");
  assertEquals(msg.includes("https://wa.me/59891112233"), true);
  assertEquals(msg.includes("+"), false);
  assertEquals(msg.includes("{"), false);
});

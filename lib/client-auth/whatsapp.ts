/**
 * Node-side WhatsApp send for the login code (Phase 1 slice 3). Mirrors the
 * Deno `sendWhatsAppTemplate` in supabase/functions/_shared/notify.ts (same
 * Graph API shape, es_UY, one body param), but reads process.env and is called
 * from the Next route handler that mints the client session (a cookie op that
 * must live Node-side).
 *
 * DEV/CI STUB: if WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID are unset, or a
 * CLIENT_AUTH_TEST_MODE flag is on, we DON'T call Meta — the code is logged
 * server-side (never to the client) so the flow can be exercised without an
 * approved template or a real send. Braulio approves the Meta authentication
 * template separately; until then this keeps development unblocked.
 */

const GRAPH_VERSION = "v20.0";

/** The approved Meta authentication template name (es_UY, one {{1}} = code). */
const AUTH_TEMPLATE = "codigo_login";

/** True when we must NOT hit Meta (missing creds or explicit test mode). */
function isStubMode(): boolean {
  if (process.env.CLIENT_AUTH_TEST_MODE === "1") return true;
  return !process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID;
}

/**
 * Send the login code to a phone (E.164 with '+') via the authentication
 * template. In stub mode, logs the code server-side and returns without a send.
 * Throws only on a real Meta error (so the route can 500 and the client retry).
 */
export async function sendLoginCode(phone: string, code: string): Promise<void> {
  if (isStubMode()) {
    // Server-side only — never returned to the client. Last-4 of the phone to
    // avoid logging full numbers (CLAUDE.md).
    console.info(
      `[client-auth stub] login code for ...${phone.slice(-4)}: ${code}`,
    );
    return;
  }

  const token = process.env.WHATSAPP_TOKEN!;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID!;
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone.replace(/^\+/, ""), // Graph wants no leading '+'
        type: "template",
        template: {
          name: AUTH_TEMPLATE,
          language: { code: "es_UY" },
          // AUTHENTICATION templates carry a copy-code URL button, and Graph
          // REQUIRES its parameter alongside the body's — sending only the
          // body is rejected ("number of parameters does not match"), which
          // surfaced as the public page's "No se pudo enviar el código".
          components: [
            {
              type: "body",
              parameters: [{ type: "text", text: code }],
            },
            {
              type: "button",
              sub_type: "url",
              index: "0",
              parameters: [{ type: "text", text: code }],
            },
          ],
        },
      }),
    },
  );
  if (!res.ok) {
    // Do NOT include the code or the full phone in the error.
    throw new Error(`whatsapp login code: HTTP ${res.status}`);
  }
}

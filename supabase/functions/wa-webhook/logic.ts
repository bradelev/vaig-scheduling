/**
 * Pure parsing + signature logic for wa-webhook (PRD FR-3, issue E5-T1).
 * Signature validation is security-sensitive — architect-owned, never
 * delegated (CLAUDE.md). No I/O here; the DB update lives in index.ts.
 */

export type ButtonAction =
  | { kind: "confirm"; sessionId: string }
  | { kind: "reschedule"; sessionId: string };

/**
 * Extract the button actions from a WhatsApp webhook payload (FR-3).
 * Only `messages[].type === 'button'` with a CONFIRM_/RESCHED_ payload
 * yields an action; everything else (text, status callbacks, other types)
 * yields nothing → the caller answers 200 with no side effect.
 */
export function parseButtonActions(body: unknown): ButtonAction[] {
  const actions: ButtonAction[] = [];
  const entries = (body as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return actions;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown[] } })?.value
        ?.messages;
      if (!Array.isArray(messages)) continue;
      for (const msg of messages) {
        const m = msg as { type?: string; button?: { payload?: string } };
        if (m.type !== "button") continue;
        const payload = m.button?.payload ?? "";
        const action = payloadToAction(payload);
        if (action) actions.push(action);
      }
    }
  }
  return actions;
}

/** CONFIRM_{id} / RESCHED_{id} → action, else null. */
export function payloadToAction(payload: string): ButtonAction | null {
  const confirm = payload.match(/^CONFIRM_(.+)$/);
  if (confirm) return { kind: "confirm", sessionId: confirm[1] };
  const resched = payload.match(/^RESCHED_(.+)$/);
  if (resched) return { kind: "reschedule", sessionId: resched[1] };
  return null;
}

/** Constant-time compare of two equal-length byte arrays. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const hexToBytes = (hex: string): Uint8Array | null => {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/**
 * Validate Meta's `X-Hub-Signature-256: sha256=<hex>` header: HMAC-SHA256 of
 * the RAW request body with META_APP_SECRET (FR-3). Constant-time compare.
 * Returns false on any malformed input rather than throwing.
 */
export async function verifySignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!header || !appSecret) return false;
  const prefix = "sha256=";
  if (!header.startsWith(prefix)) return false;
  const provided = hexToBytes(header.slice(prefix.length));
  if (!provided) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)),
  );
  return timingSafeEqual(mac, provided);
}

/**
 * Fixed transactional ack sent to the CLIENT after she taps "Reagendar"
 * (issue #66). Free-form text — her tap opens Meta's 24h service window,
 * so no template is involved. NOT a chatbot: one fixed sentence, no
 * parsing, no conversation (scope ruled by Braulio, 2026-07-22).
 * Customer-facing Spanish by design.
 */
export const RESCHED_ACK_MESSAGE =
  "¡Gracias por avisar! 🌸 Te vamos a escribir desde el número del local para coordinar un nuevo horario.";

/**
 * Where the ack goes (issue #66): the rehearsal override ALWAYS wins — a
 * rehearsal tap must never message the real client. Empty-string override
 * counts as unset (same convention as send-reminders). Returns null when
 * there is nobody safe to message.
 */
export function ackRecipient(
  clientPhone: string | null,
  override: string | undefined,
): string | null {
  // Same convention as send-reminders: a SET override means rehearsal, so
  // the client is never an option — and a malformed one means "send to
  // nobody", never "fall back to the real phone".
  if (override !== undefined && override !== "") {
    return /^\+\d{8,15}$/.test(override) ? override : null;
  }
  return clientPhone || null;
}

/**
 * Fixed transactional ack after "Confirmar" (issue #68) — same 24h-window
 * mechanics and same non-chatbot ruling as RESCHED_ACK_MESSAGE. The
 * session's Montevideo date/time is interpolated by the caller.
 * Customer-facing Spanish by design.
 */
export function confirmAckMessage(dateLabel: string, timeLabel: string): string {
  return `¡Gracias por confirmar! 🌸 Te esperamos el ${dateLabel} a las ${timeLabel}.`;
}

/**
 * Fixed redirect for free text sent to the BOT number (issue #74) — it has
 * no inbox, so without this a client talks into a void with blue ticks on.
 * NOT a chatbot: one fixed sentence, content never parsed (owner ruling
 * 2026-07-23). Customer-facing Spanish by design. `shopWa` is the shop's
 * HUMAN number (E.164) — the message points there.
 */
export function botRedirectMessage(shopWa: string): string {
  const digits = shopWa.replace(/\D/g, "");
  return `Este es el número de avisos automáticos de VAIG 🤖 ` +
    `Para consultas y reservas escribinos al WhatsApp del local 👉 https://wa.me/${digits}`;
}

/**
 * Sender phones of inbound messages that are NOT button taps (text, audio,
 * image… all mean "a human wants to talk"). Deduped — one redirect decision
 * per sender per webhook delivery.
 */
export function parseRedirectSenders(body: unknown): string[] {
  const senders = new Set<string>();
  const entries = (body as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return [];
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown[] } })?.value
        ?.messages;
      if (!Array.isArray(messages)) continue;
      for (const msg of messages) {
        const m = msg as { type?: string; from?: string };
        if (typeof m.type !== "string" || m.type === "button") continue;
        if (typeof m.from === "string" && m.from.trim() !== "") {
          senders.add(m.from.trim());
        }
      }
    }
  }
  return [...senders];
}

const REDIRECT_WINDOW_MS = 24 * 3_600_000;

/**
 * Rate limit for the redirect (issue #74): at most one per sender per 24h,
 * so three messages in a row never earn three robotic replies. `lastIso`
 * is the sender's stored replied_at, null when never replied.
 */
export function shouldReply(lastIso: string | null, nowMs: number): boolean {
  if (lastIso === null) return true;
  const last = new Date(lastIso).getTime();
  if (Number.isNaN(last)) return true;
  return nowMs - last >= REDIRECT_WINDOW_MS;
}

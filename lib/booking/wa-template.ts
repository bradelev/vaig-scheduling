/**
 * Send an approved WhatsApp (Meta Graph) template with text body params —
 * shared by the booking notices (staff: nueva_reserva_staff; client:
 * reserva_confirmada). Node-only (reads process.env for the credentials).
 *
 * Stub mode (missing creds or CLIENT_AUTH_TEST_MODE=1) logs instead of sending
 * — last-4 of the phone only (CLAUDE.md: never log full numbers). Throws on a
 * real Meta error; callers decide whether that is fatal (the booking notices
 * are best-effort).
 */

const GRAPH_VERSION = "v20.0";
const LANGUAGE = "es_UY";

/** True when we must NOT hit Meta (missing creds or explicit test mode). */
export function isStubMode(): boolean {
  if (process.env.CLIENT_AUTH_TEST_MODE === "1") return true;
  return !process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID;
}

export async function sendTemplate(input: {
  /** E.164 with '+'. */
  to: string;
  template: string;
  /** Body params in template order ({{1}}, {{2}}, …). Never empty strings. */
  params: string[];
  /** What the stub log calls this send, e.g. "new-reservation notice to staff". */
  stubLabel: string;
}): Promise<void> {
  if (isStubMode()) {
    console.info(
      `[booking stub] ${input.stubLabel} ...${input.to.slice(-4)}: ${input.params.join(" | ")}`,
    );
    return;
  }

  const token = process.env.WHATSAPP_TOKEN!;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID!;
  const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: input.to.replace(/^\+/, ""), // Graph wants no leading '+'
      type: "template",
      template: {
        name: input.template,
        language: { code: LANGUAGE },
        components: [
          { type: "body", parameters: input.params.map((text) => ({ type: "text", text })) },
        ],
      },
    }),
  });
  if (!resp.ok) {
    // Do NOT include the phone in the error.
    throw new Error(`${input.template}: HTTP ${resp.status}`);
  }
}

/**
 * "lunes 8/9 a las 14:00" — an instant as Montevideo wall-clock, Spanish.
 * Customer/staff-facing copy (the Spanish exception applies).
 */
export function dateTimeLabel(iso: string): string {
  const d = new Date(iso);
  const dateParts = new Intl.DateTimeFormat("es-UY", {
    timeZone: "America/Montevideo",
    weekday: "long",
    day: "numeric",
    month: "numeric",
  }).formatToParts(d);
  const get = (t: string) => dateParts.find((p) => p.type === t)?.value ?? "";
  const time = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const gt = (t: string) => time.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")}/${get("month")} a las ${gt("hour")}:${gt("minute")}`;
}

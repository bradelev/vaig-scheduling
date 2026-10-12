/**
 * Notification channels for operational events (issue E6-T3): WhatsApp
 * templates + Resend email. Contacts and keys come from env secrets —
 * personal data never lives in the repo. Every channel is optional (missing
 * env → silently skipped) and a notification failure NEVER breaks the run
 * that triggered it: callers get best-effort delivery, errors are logged
 * (redacted) and swallowed.
 */
import { type AlertKind, templateParam } from "./alerting.ts";

const GRAPH_VERSION = "v20.0";

type Channels = { phone?: string; email?: string };

function adminChannels(): Channels {
  return {
    phone: Deno.env.get("NOTIFY_ADMIN_PHONE") ?? undefined,
    email: Deno.env.get("NOTIFY_ADMIN_EMAIL") ?? undefined,
  };
}
function techChannels(): Channels {
  return {
    phone: Deno.env.get("NOTIFY_TECH_PHONE") ?? undefined,
    email: Deno.env.get("NOTIFY_TECH_EMAIL") ?? undefined,
  };
}

async function sendWhatsAppTemplate(
  to: string,
  template: string,
  params: string[],
): Promise<void> {
  const token = Deno.env.get("WHATSAPP_TOKEN");
  const phoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneId) return;
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
        to: to.replace(/^\+/, ""),
        type: "template",
        template: {
          name: template,
          language: { code: "es_UY" },
          components: [
            {
              type: "body",
              parameters: params.map((text) => ({ type: "text", text })),
            },
          ],
        },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`whatsapp ${template}: HTTP ${res.status} ${templateParam(body)}`);
  }
}

async function sendEmail(
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return;
  const from = Deno.env.get("NOTIFY_EMAIL_FROM") ?? "VAIG <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`resend: HTTP ${res.status} ${templateParam(body)}`);
  }
}

/**
 * Free-form text inside Meta's 24h customer-service window (issue #66):
 * the recipient's own message (e.g. a button tap) opened the window, so no
 * template is needed. Throws on HTTP error (redacted) — callers decide how
 * to degrade. Env-gated like every channel here.
 */
export async function sendServiceWindowText(
  to: string,
  body: string,
): Promise<void> {
  const token = Deno.env.get("WHATSAPP_TOKEN");
  const phoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneId) return;
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
        to: to.replace(/^\+/, ""),
        type: "text",
        text: { body },
      }),
    },
  );
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`whatsapp text: HTTP ${res.status} ${templateParam(errBody)}`);
  }
}

/** Best-effort fan-out to a contact's channels; never throws. */
async function deliver(
  channels: Channels,
  wa: { template: string; params: string[] },
  mail: { subject: string; text: string },
): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (channels.phone) {
    tasks.push(sendWhatsAppTemplate(channels.phone, wa.template, wa.params));
  }
  if (channels.email) tasks.push(sendEmail(channels.email, mail.subject, mail.text));
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") {
      console.error(`notify failed: ${templateParam(String(r.reason))}`);
    }
  }
}

/** Daily reminder-batch summary → admin (issue E6-T3 role: Cynthia). */
export async function notifyDailySummary(sent: number, errors: number): Promise<void> {
  await deliver(
    adminChannels(),
    {
      template: "resumen_recordatorios",
      params: [String(sent), String(errors)],
    },
    {
      subject: `VAIG · resumen de recordatorios: ${sent} enviados, ${errors} con error`,
      text:
        `Resumen del batch de hoy:\n\n` +
        `Recordatorios enviados: ${sent}\n` +
        `Con error: ${errors}\n\n` +
        `Detalle en la app: https://vaig-automation.vercel.app/clientas`,
    },
  );
}

/**
 * Daily review-request-batch summary → admin (PRD §III, layer 3). EMAIL ONLY:
 * unlike the reminders summary this has no approved WhatsApp template
 * (`resumen_recordatorios` is reminder-specific), and a review summary doesn't
 * warrant blocking on another Meta approval. The email channel is free text,
 * so the admin still gets a distinct, correctly-labeled summary.
 */
export async function notifyReviewSummary(sent: number, errors: number): Promise<void> {
  const { email } = adminChannels();
  if (!email) return;
  await sendEmail(
    email,
    `VAIG · resumen de pedidos de reseña: ${sent} enviados, ${errors} con error`,
    `Resumen del batch de pedidos de reseña de hoy:\n\n` +
      `Pedidos enviados: ${sent}\n` +
      `Con error: ${errors}\n\n` +
      `Detalle en la app: https://vaig-automation.vercel.app/resenas`,
  );
}

/**
 * A client tapped "Reagendar" → admin, instantly (issue #62). Template
 * `reagenda_solicitada` (es_UY); the email mirrors it with a deep link to
 * the 🔁 filter. Staff-facing Spanish copy by design.
 */
export async function notifyRescheduleRequest(
  clientName: string,
  dateLabel: string,
  timeLabel: string,
): Promise<void> {
  await deliver(
    adminChannels(),
    {
      template: "reagenda_solicitada",
      params: [clientName, dateLabel, timeLabel],
    },
    {
      subject: `VAIG 🔁 ${clientName} pidió reagendar (${dateLabel} ${timeLabel})`,
      text:
        `${clientName} no puede ir a su sesión del ${dateLabel} a las ${timeLabel}.\n` +
        `Escribile desde el número del local para coordinar un nuevo horario.\n\n` +
        `Ver en la app: https://vaig-automation.vercel.app/clientas?filtro=reagendar`,
    },
  );
}

/** Dashboard link to the functions' logs, derived from the project URL. */
function functionsLogsUrl(): string {
  const host = Deno.env.get("SUPABASE_URL")?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  return host
    ? `https://supabase.com/dashboard/project/${host}/functions`
    : "https://supabase.com/dashboard";
}

/** OK→fail / fail→OK transition → tech (issue E6-T3 role: Braulio). */
export async function notifyTransition(
  job: string,
  kind: AlertKind,
  detail: string,
): Promise<void> {
  const estado = kind === "fail" ? "con errores" : "recuperado";
  const clean = templateParam(detail);
  await deliver(
    techChannels(),
    {
      template: "alerta_sistema",
      params: [job, estado, clean === "" ? "sin detalle" : clean],
    },
    {
      subject: `VAIG ⚠ ${job} ${estado}`,
      text:
        `Proceso: ${job}\nEstado: ${estado}\nDetalle: ${clean || "sin detalle"}\n\n` +
        `Logs: ${functionsLogsUrl()}`,
    },
  );
}

/**
 * Outcome of the run BEFORE the current one (rows[0] is the row the caller
 * just finished writing). null = no history. A crashed run (ok never set)
 * counts as not-ok, so the next success emits a recovery notice.
 */
export async function previousRunOk(job: string): Promise<boolean | null> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  const res = await fetch(
    `${url}/rest/v1/job_runs?select=ok&job=eq.${encodeURIComponent(job)}` +
      `&order=started_at.desc&limit=2`,
    { headers: { apikey: key, authorization: `Bearer ${key}` } },
  );
  if (!res.ok) return null;
  const rows: { ok: boolean | null }[] = await res.json();
  if (rows.length < 2) return null;
  return rows[1].ok === true;
}

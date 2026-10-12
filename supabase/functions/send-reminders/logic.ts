/**
 * Pure logic for the send-reminders function (PRD FR-2, issue E4-T2).
 * No I/O here: everything is unit-testable under `deno test`.
 */

export const TIMEZONE = "America/Montevideo";

/**
 * Template names (PRD §9.2, es_UY). The no-service variant (issue #75)
 * simply omits the service phrase — "tu sesión de tratamiento" read like
 * filler, so when the service is unknown the message says "tu sesión el
 * jue 23/07 …" instead. Both carry the same Confirmar/Reagendar buttons.
 */
export const TEMPLATE_WITH_SERVICE = "recordatorio_sesion";
export const TEMPLATE_NO_SERVICE = "recordatorio_sesion_sin_servicio";

export type Candidate = {
  id: string;
  client_id: string;
  starts_at: string; // ISO timestamp
  service: string | null;
  full_name: string;
  phone: string; // E.164 (+598...)
};

export type SkippedCandidate = {
  session_id: string;
  client_id: string;
  reason:
    | "already_reminded_same_day"
    | "duplicate_in_batch"
    | "external_covers_same_day";
};

/** Calendar day of a timestamp in Montevideo, as YYYY-MM-DD (en-CA format). */
export function localDayKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

const HOUR_MS = 3_600_000;

/**
 * Half-open UTC window covering the whole NEXT Montevideo calendar day,
 * [tomorrow 00:00, day-after 00:00) local (FR-2, issue #78): the 16:00
 * batch reminds every session of the next day — a rolling now+24h window
 * fired at 16:00 would never see tomorrow-morning sessions. Uruguay
 * abolished DST in 2015, so the fixed -03:00 offset is exact year-round
 * (same rationale as the cron migrations) and adding 24h to a local
 * midnight always lands on the next local midnight.
 */
export function nextLocalDayWindow(
  now: Date,
): { fromIso: string; toIso: string } {
  const todayMidnight = new Date(
    `${localDayKey(now.toISOString())}T00:00:00-03:00`,
  );
  return {
    fromIso: new Date(todayMidnight.getTime() + 24 * HOUR_MS).toISOString(),
    toIso: new Date(todayMidnight.getTime() + 48 * HOUR_MS).toISOString(),
  };
}

/**
 * The local hour the daily batch fires (16:00 Montevideo = the `0 19 * * *`
 * UTC cron; Uruguay has no DST so the offset is fixed). Kept here as the one
 * place the immediate-reminder logic and the batch schedule agree on.
 */
export const SEND_HOUR_LOCAL = 16;

/** Montevideo hour (0–23) of an instant. */
function localHour(iso: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIMEZONE,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso)),
  );
}

/**
 * Does a just-created/-moved app session need an IMMEDIATE reminder rather
 * than waiting for a batch (issue #120, PRD §II.5)? The batch runs once at
 * 16:00 for the whole NEXT local day. A session for tomorrow created AFTER
 * today's 16:00 batch falls into a 24h hole — today's batch already ran,
 * tomorrow's looks at the day after. Only that case needs an immediate send:
 *
 *   - session is on the NEXT local day (tomorrow), AND
 *   - now is at/after today's send hour (the batch already ran or is running)
 *
 * Everything else is covered by a batch: a tomorrow session created before
 * 16:00 today is caught by today's batch; a session 2+ days out is caught by
 * a future batch; a same-day session is past the day-before reminder horizon
 * and out of scope. All comparisons are in America/Montevideo.
 */
export function needsImmediateReminder(startsAtIso: string, now: Date): boolean {
  const nowIso = now.toISOString();
  const todayKey = localDayKey(nowIso);
  const tomorrowKey = localDayKey(
    new Date(
      new Date(`${todayKey}T00:00:00-03:00`).getTime() + 24 * HOUR_MS,
    ).toISOString(),
  );
  const sessionDay = localDayKey(startsAtIso);
  if (sessionDay !== tomorrowKey) return false; // not tomorrow → a batch covers it
  return localHour(nowIso) >= SEND_HOUR_LOCAL; // today's batch already ran
}

/**
 * Customer-facing short date in Montevideo, e.g. "mié 15/07" (PRD FR-2).
 * Day/month padding is composed by hand: ICU's flexible pattern matching
 * makes "2-digit" unreliable across locales (es-UY yields "15/7").
 */
export function formatReminderDate(iso: string): string {
  const weekday = new Intl.DateTimeFormat("es-UY", {
    timeZone: TIMEZONE,
    weekday: "short",
  })
    .format(new Date(iso))
    .replaceAll(".", "");
  const [, month, day] = localDayKey(iso).split("-");
  return `${weekday} ${day}/${month}`;
}

/** Customer-facing time in Montevideo, 24h, e.g. "14:30" (PRD FR-2). */
export function formatReminderTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour").padStart(2, "0")}:${get("minute").padStart(2, "0")}`;
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? "";
}

/** Graph API wants the number without the leading +. */
export function waPhone(e164: string): string {
  return e164.replace(/^\+/, "");
}

/** Only the last 4 digits ever reach logs (CLAUDE.md sensitive-data rule). */
export function phoneLast4(phone: string): string {
  return phone.slice(-4);
}

/**
 * Redacts any 7+ digit run down to its last 4. Applied to every error
 * string before it reaches job_runs.detail — Graph API validation errors
 * echo the recipient number back in their body.
 */
export function redactPhones(text: string): string {
  return text.replace(/\d{7,}/g, (m) => `***${m.slice(-4)}`);
}

function clientDayKey(clientId: string, iso: string): string {
  return `${clientId}|${localDayKey(iso)}`;
}

export function remindedKeys(
  rows: { client_id: string; starts_at: string }[],
): Set<string> {
  return new Set(rows.map((r) => clientDayKey(r.client_id, r.starts_at)));
}

/**
 * At most one reminder per client per Montevideo calendar day (PRD FR-2 +
 * §7.0 External/manual duplicates). Earliest session of the day wins;
 * anything already reminded the same local day is skipped without sending
 * or marking. `externalCovered` (issue #69): client|day keys of SCHEDULED
 * external sessions — External reminds its own bookings, so their manual
 * twins are skipped too, with their own audit reason.
 */
export function dedupeByClientDay(
  candidates: Candidate[],
  alreadyReminded: Set<string>,
  externalCovered: Set<string> = new Set(),
): { toSend: Candidate[]; skipped: SkippedCandidate[] } {
  const sorted = [...candidates].sort((a, b) =>
    a.starts_at.localeCompare(b.starts_at),
  );
  const chosen = new Map<string, Candidate>();
  const skipped: SkippedCandidate[] = [];
  for (const c of sorted) {
    const key = clientDayKey(c.client_id, c.starts_at);
    if (alreadyReminded.has(key)) {
      skipped.push({
        session_id: c.id,
        client_id: c.client_id,
        reason: "already_reminded_same_day",
      });
    } else if (externalCovered.has(key)) {
      skipped.push({
        session_id: c.id,
        client_id: c.client_id,
        reason: "external_covers_same_day",
      });
    } else if (chosen.has(key)) {
      skipped.push({
        session_id: c.id,
        client_id: c.client_id,
        reason: "duplicate_in_batch",
      });
    } else {
      chosen.set(key, c);
    }
  }
  return { toSend: [...chosen.values()], skipped };
}

/**
 * Reminder template payload (PRD §9.2, language es_UY). Picks the variant
 * per candidate (issue #75): a known service uses `recordatorio_sesion`
 * (4 params); an unknown/blank one uses the 3-param no-service template —
 * Meta rejects empty params, so omitting the slot needs its own template.
 * `overrideTo` (rehearsal mode, issue #60) replaces ONLY the destination:
 * body params and button payloads still reference the real session, so a
 * rehearsal exercises the exact bytes production would send.
 */
export function buildTemplatePayload(
  c: Candidate,
  overrideTo?: string,
): Record<string, unknown> {
  // Blank counts as unknown too, not only null.
  const service = c.service?.trim() || null;
  const texts = service
    ? [
      firstName(c.full_name),
      service,
      formatReminderDate(c.starts_at),
      formatReminderTime(c.starts_at),
    ]
    : [
      firstName(c.full_name),
      formatReminderDate(c.starts_at),
      formatReminderTime(c.starts_at),
    ];
  return {
    messaging_product: "whatsapp",
    to: waPhone(overrideTo ?? c.phone),
    type: "template",
    template: {
      name: service ? TEMPLATE_WITH_SERVICE : TEMPLATE_NO_SERVICE,
      language: { code: "es_UY" },
      components: [
        {
          type: "body",
          parameters: texts.map((text) => ({ type: "text", text })),
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [{ type: "payload", payload: `CONFIRM_${c.id}` }],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "1",
          parameters: [{ type: "payload", payload: `RESCHED_${c.id}` }],
        },
      ],
    },
  };
}

/**
 * Pure shaping for the "Reservas por confirmar" panel: group pending
 * reservations by Montevideo day with a human label, and label a time range.
 * No I/O — unit-tested.
 */

export type PendingReservation = {
  id: string;
  startsAt: string;
  endsAt: string | null;
  clientName: string;
  clientPhone: string | null;
  /** The catalog item's name, or the best fallback (note / service slug). */
  serviceName: string;
  staffId: string | null;
  createdAt: string;
  /** Its start time already passed — nobody confirmed nor cancelled it. */
  stale: boolean;
  /** The cuponera this reservation drew a credit from, or null. `unpaid`
   *  flags pendiente_pago — the team charges it on the client's first visit. */
  pkg: { total: number; used: number; unpaid: boolean } | null;
};

export type PendingDayGroup = {
  dayKey: string;
  label: string;
  items: PendingReservation[];
};

const TZ = "America/Montevideo";

/** ISO instant → Montevideo YYYY-MM-DD. */
export function dayKeyOf(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "14:00–15:00" (or "14:00" when the end is unknown), Montevideo wall-clock. */
export function timeRangeLabel(startsAt: string, endsAt: string | null): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const start = fmt.format(new Date(startsAt));
  return endsAt ? `${start}–${fmt.format(new Date(endsAt))}` : start;
}

/** "Hoy · lunes 7/9", "Mañana · martes 8/9", "miércoles 9/9". Staff-facing. */
export function dayLabel(dayKey: string, todayKey: string): string {
  const d = new Date(`${dayKey}T12:00:00-03:00`);
  const parts = new Intl.DateTimeFormat("es-UY", {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "numeric",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const base = `${get("weekday")} ${get("day")}/${get("month")}`;
  if (dayKey === todayKey) return `Hoy · ${base}`;
  if (dayKey === nextDayKey(todayKey)) return `Mañana · ${base}`;
  return base;
}

function nextDayKey(dayKey: string): string {
  return dayKeyOf(new Date(new Date(`${dayKey}T12:00:00-03:00`).getTime() + 86_400_000).toISOString());
}

/** Group by day, in start order (the input is expected sorted by startsAt). */
export function groupPendingByDay(
  items: PendingReservation[],
  nowMs: number,
): PendingDayGroup[] {
  const todayKey = dayKeyOf(new Date(nowMs).toISOString());
  const groups: PendingDayGroup[] = [];
  for (const it of items) {
    const key = dayKeyOf(it.startsAt);
    const last = groups[groups.length - 1];
    if (last && last.dayKey === key) last.items.push(it);
    else groups.push({ dayKey: key, label: dayLabel(key, todayKey), items: [it] });
  }
  return groups;
}

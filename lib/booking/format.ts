/**
 * Presentation helpers for booking slots — pure, Montevideo-fixed, testable.
 * Extracted from the Nueva-sesión client component so the timezone conversion
 * that feeds the datetime-local field (the P1 double-book risk) is unit-tested,
 * not buried in JSX. All output is Montevideo wall-clock (fixed -03:00, no DST).
 */

/**
 * A slot instant (ISO) → the "YYYY-MM-DDTHH:mm" a datetime-local input expects,
 * in MONTEVIDEO wall-clock (NOT the browser's). So a slot at 10:00 MVD fills the
 * field as "…T10:00" on any device. The submit path pairs this with the raw
 * instant (never re-parsing this string in the browser tz), so the booked time
 * equals the shown time regardless of the operator's device timezone.
 */
export function slotToLocalInput(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** "09:00" in Montevideo — the label on a slot chip. */
export function slotTimeLabel(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

/** "mié 03/09" — the header for a day of slots (Montevideo, Spanish weekday). */
export function slotDayLabel(dayKey: string): string {
  // dayKey is already YYYY-MM-DD (Montevideo); anchor at local noon to name it.
  const noon = new Date(`${dayKey}T12:00:00-03:00`);
  const wd = new Intl.DateTimeFormat("es-UY", {
    timeZone: "America/Montevideo",
    weekday: "short",
  }).format(noon);
  const [, m, d] = dayKey.split("-");
  return `${wd} ${d}/${m}`;
}

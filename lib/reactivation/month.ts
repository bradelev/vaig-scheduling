/**
 * Spanish month label for the reactivation copy (the {mes} token). The message
 * says "tu última sesión de {servicio} fue en {mes}" — {mes} is the month name
 * in Montevideo local time, warm and informal ("marzo"). When the session is
 * 12+ months old the bare month is ambiguous ("marzo" could be last year), so
 * we append the year only then ("marzo de 2025"). Pure and I/O-free.
 */

/** Whole months from `iso` up to `now` in Montevideo time (never negative). */
function monthsElapsed(iso: string, now: Date): number {
  const parts = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Montevideo",
      year: "numeric",
      month: "numeric",
    }).formatToParts(d);
  const get = (d: Date, t: string) =>
    Number(parts(d).find((p) => p.type === t)?.value ?? "0");
  const months =
    (get(now, "year") - get(new Date(iso), "year")) * 12 +
    (get(now, "month") - get(new Date(iso), "month"));
  return Math.max(0, months);
}

/**
 * "marzo" if the session is within the last 12 months, else "marzo de 2025".
 * Month name and year are both resolved in America/Montevideo.
 */
export function monthLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const raw = new Intl.DateTimeFormat("es-UY", {
    timeZone: "America/Montevideo",
    month: "long",
  }).format(date);
  // Some ICU builds capitalize the standalone month ("Marzo"); the copy uses it
  // mid-sentence ("fue en marzo"), so force lowercase.
  const month = raw.charAt(0).toLowerCase() + raw.slice(1);
  if (monthsElapsed(iso, now) < 12) return month;
  const year = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    year: "numeric",
  }).format(date);
  return `${month} de ${year}`;
}

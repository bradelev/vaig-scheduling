/**
 * Pure helpers for the public booking page (Phase 2, the internal booking plan
 * §"Página pública"): catalog grouping, the week strip, price/date labels.
 * No I/O — unit-tested. All dates are Montevideo wall-clock (fixed -03:00).
 */

export type CatalogItem = {
  id: string;
  name: string;
  category: string;
  durationMin: number;
  priceUyu: number | null;
  depositUyu: number | null;
  /** Sessions included when the item is a prepaid package (cuponera); null otherwise. */
  packageSessions: number | null;
};

export type CatalogGroup = { category: string; items: CatalogItem[] };

/**
 * Categories the business leads with — shown first, in this order. Everything
 * else follows in first-appearance (catalog sort_order) order.
 */
const LEAD_CATEGORIES = ["Depilación Láser", "Cuponeras de Depilación Láser"];

/**
 * Group active items by category, keeping the catalog's own order (sort_order,
 * then name) inside each group; the lead categories come first, the rest in
 * first-appearance order.
 */
export function groupCatalog(items: CatalogItem[]): CatalogGroup[] {
  const groups: CatalogGroup[] = [];
  const byCat = new Map<string, CatalogGroup>();
  for (const it of items) {
    let g = byCat.get(it.category);
    if (!g) {
      g = { category: it.category, items: [] };
      byCat.set(it.category, g);
      groups.push(g);
    }
    g.items.push(it);
  }
  const rank = (c: string) => {
    const i = LEAD_CATEGORIES.indexOf(c);
    return i === -1 ? LEAD_CATEGORIES.length : i;
  };
  // Stable sort: equal ranks keep first-appearance order.
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => rank(a.g.category) - rank(b.g.category) || a.i - b.i)
    .map((x) => x.g);
}

/** "$1.850" — Uruguayan pesos, thousands with a dot, no decimals. */
export function formatPrice(uyu: number | null): string | null {
  if (uyu === null || !Number.isFinite(uyu)) return null;
  return `$${Math.round(uyu).toLocaleString("es-UY")}`;
}

/** "60 min" / "1 h" / "1 h 30" */
export function formatDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m}`;
}

const TZ = "America/Montevideo";

/** Fixed Spanish short names — ICU's es-UY output varies by version ("Set."
 *  for setiembre, capitalization), which would make labels drift. */
const WEEKDAYS_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** 0 = Sunday … 6 = Saturday, for the Montevideo day of an instant. */
function weekdayIndex(d: Date): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

/** ISO instant → Montevideo YYYY-MM-DD. */
export function dayKeyOf(iso: string | number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** dayKey + n days (n may be negative). */
export function addDays(dayKey: string, n: number): string {
  return dayKeyOf(new Date(`${dayKey}T12:00:00-03:00`).getTime() + n * 86_400_000);
}

/** The Monday of the week containing dayKey (Mon–Sun weeks, like /horarios). */
export function mondayOf(dayKey: string): string {
  const idx = weekdayIndex(new Date(`${dayKey}T12:00:00-03:00`)); // 0 = Sun
  const offset = (idx + 6) % 7; // Mon → 0 … Sun → 6
  return addDays(dayKey, -offset);
}

/** The 7 day keys of the week starting at mondayKey. */
export function weekDays(mondayKey: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(mondayKey, i));
}

/**
 * The monday after `current` for the empty-week forward scan, or null when it
 * would start past the booking horizon (60 days from today — must match
 * MAX_BOOKING_HORIZON_DAYS server-side). The null is what stops the scan.
 */
export function nextScanMonday(current: string, todayKey: string): string | null {
  const next = addDays(current, 7);
  return next <= addDays(todayKey, 60) ? next : null;
}

/** "1 – 7 sep" / "31 ago – 6 sep" — the week strip title. */
export function weekLabel(mondayKey: string): string {
  const dayOf = (k: string) => String(Number(k.slice(8, 10)));
  const monOf = (k: string) => MONTHS_SHORT[Number(k.slice(5, 7)) - 1];
  const sunday = addDays(mondayKey, 6);
  const sameMonth = mondayKey.slice(0, 7) === sunday.slice(0, 7);
  const start = sameMonth ? dayOf(mondayKey) : `${dayOf(mondayKey)} ${monOf(mondayKey)}`;
  return `${start} – ${dayOf(sunday)} ${monOf(sunday)}`;
}

/** { wd: "Jue", dd: "3" } for the day strip. */
export function dayChip(dayKey: string): { wd: string; dd: string } {
  const wd = WEEKDAYS_SHORT[weekdayIndex(new Date(`${dayKey}T12:00:00-03:00`))];
  return { wd: wd.charAt(0).toUpperCase() + wd.slice(1), dd: String(Number(dayKey.slice(8, 10))) };
}

/** "14:30" in Montevideo. */
export function timeLabel(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

/** "jue 3/9 · 14:30" — the summary line. */
export function summaryWhen(iso: string): string {
  const d = new Date(iso);
  const key = dayKeyOf(iso);
  const wd = WEEKDAYS_SHORT[weekdayIndex(d)];
  return `${wd} ${Number(key.slice(8, 10))}/${Number(key.slice(5, 7))} · ${timeLabel(iso)}`;
}

/** Initial for the professional's avatar. */
export function initialOf(label: string): string {
  return (label.trim().charAt(0) || "?").toUpperCase();
}

/**
 * Format what the user types in the phone field as "099 123 456" while they
 * type (Uruguayan mobile). Only digits are kept; anything longer is left as
 * digits so international numbers still work.
 */
export function formatPhoneInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 15);
  if (digits.length <= 9 && digits.startsWith("09")) {
    return [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)].filter(Boolean).join(" ");
  }
  return raw.startsWith("+") ? `+${digits}` : digits;
}

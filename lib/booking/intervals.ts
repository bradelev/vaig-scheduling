/**
 * Pure interval algebra for the slot engine (Phase 1B of the online booking
 * plan). NO I/O, NO timezone, NO dates — just integer minute ranges. This is the
 * load-bearing math (union / subtract / cut into slots); it's kept separate and
 * exhaustively tested so the timezone-conversion layer (slots.ts) can stay thin.
 *
 * An Interval is [start, end) in "minutes from local midnight" (0..1440),
 * half-open: end is exclusive, so [540,600) and [600,660) are adjacent, not
 * overlapping. All functions treat inputs as unsorted and possibly overlapping
 * and return NORMALIZED output (sorted, merged, no empties).
 */

/** A half-open minute range [start, end). Both in [0, 1440]. start < end. */
export type Interval = { start: number; end: number };

/**
 * Merge a set of intervals into the minimal sorted set of non-overlapping,
 * non-adjacent-touching... — actually we DO merge touching ([540,600)+[600,660)
 * → [540,660)), because for availability "9–10 then 10–11" is one continuous
 * 9–11 block. Empty/inverted intervals (start >= end) are dropped.
 */
export function normalize(intervals: Interval[]): Interval[] {
  const valid = intervals
    .filter((i) => i.start < i.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const iv of valid) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      // Overlapping OR touching (iv.start === last.end) → extend.
      last.end = Math.max(last.end, iv.end);
    } else {
      out.push({ start: iv.start, end: iv.end });
    }
  }
  return out;
}

/** Union = normalize of the concatenation (merges everything). */
export function union(a: Interval[], b: Interval[]): Interval[] {
  return normalize([...a, ...b]);
}

/**
 * Subtract `holes` from `base`: every minute in base that is NOT covered by any
 * hole. Used for (availability − blocks) and (that − booked sessions). Both
 * sides are normalized first, so callers may pass raw overlapping input.
 */
export function subtract(base: Interval[], holes: Interval[]): Interval[] {
  const src = normalize(base);
  const cut = normalize(holes);
  const out: Interval[] = [];
  for (const seg of src) {
    // Walk cursor across `seg`, punching out any overlapping hole.
    let cursor = seg.start;
    for (const h of cut) {
      if (h.end <= cursor) continue; // hole entirely before the remaining part
      if (h.start >= seg.end) break; // holes are sorted; rest are past this seg
      if (h.start > cursor) {
        // Free gap before this hole.
        out.push({ start: cursor, end: Math.min(h.start, seg.end) });
      }
      cursor = Math.max(cursor, h.end);
      if (cursor >= seg.end) break;
    }
    if (cursor < seg.end) out.push({ start: cursor, end: seg.end });
  }
  return out; // already sorted & non-overlapping by construction
}

/**
 * Cut free intervals into concrete start times for an appointment of
 * `durationMin`, spaced every `stepMin` (the grid). A start `t` is offered iff
 * [t, t+durationMin) fits entirely inside a single free interval. Starts are
 * aligned to the grid RELATIVE TO each interval's start (so a 9:07 opening with
 * step 30 offers 9:07, 9:37… — but in practice openings are on clean minutes).
 *
 * Returns the start minutes, ascending, de-duplicated across intervals.
 * `stepMin` must be > 0; `durationMin` must be > 0.
 */
export function slotStarts(
  free: Interval[],
  durationMin: number,
  stepMin: number,
): number[] {
  if (durationMin <= 0 || stepMin <= 0) return [];
  const starts: number[] = [];
  for (const iv of normalize(free)) {
    // Last start that still fits: t + durationMin <= iv.end.
    const lastStart = iv.end - durationMin;
    for (let t = iv.start; t <= lastStart; t += stepMin) {
      starts.push(t);
    }
  }
  // De-dup (adjacent intervals can't overlap, so dups only if callers pass odd
  // input, but be safe) and sort.
  return Array.from(new Set(starts)).sort((a, b) => a - b);
}

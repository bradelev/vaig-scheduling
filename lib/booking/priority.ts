/**
 * "Con quien sea" priority resolution (Phase 2 backend). Pure logic: given the
 * staff who provide a service (ordered by priority) and each one's free slots
 * for a day, decide who gets a booking. NO I/O — the query layer fetches the
 * candidates + availability; this picks. Unit-tested.
 *
 * Two booking modes (strategy doc §a):
 *  - "con quien sea" (default): assign the FIRST staff, by priority (lower
 *    number first), who has any free slot at/after the requested time.
 *  - direct choice: a specific staff — honored if they have the slot.
 * Cynthia is kept out of the operational pool by a HIGH priority number, but
 * stays selectable directly (her row is still in staff_services).
 */
import type { Slot } from "./slots";

/** A candidate professional for a service: their id + priority + free slots. */
export type Candidate = {
  staffId: string;
  priority: number;
  slots: Slot[];
};

/**
 * Pick the first candidate (by priority, then staffId for a stable tiebreak)
 * who has a slot at exactly `startsAt`. Returns the staffId, or null if no
 * candidate is free at that instant. For "con quien sea" the client picked a
 * time; we assign whoever's free then, best-priority first.
 */
export function assignByPriority(
  candidates: Candidate[],
  startsAt: string,
): string | null {
  const ordered = [...candidates].sort(
    (a, b) => a.priority - b.priority || a.staffId.localeCompare(b.staffId),
  );
  for (const c of ordered) {
    if (c.slots.some((s) => s.startsAt === startsAt)) return c.staffId;
  }
  return null;
}

/**
 * The union of all offered start instants across candidates, ascending and
 * de-duplicated — what "con quien sea" shows the client (a time is offered if
 * ANY professional is free then). Each returned slot keeps its durationMin.
 */
export function mergedSlots(candidates: Candidate[]): Slot[] {
  const byStart = new Map<string, Slot>();
  for (const c of candidates) {
    for (const s of c.slots) {
      if (!byStart.has(s.startsAt)) byStart.set(s.startsAt, s);
    }
  }
  return Array.from(byStart.values()).sort((a, b) =>
    a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0,
  );
}

/**
 * Is a specific staff free at `startsAt`? (direct-choice mode.) The caller
 * already filtered `candidates` to those who provide the service; this checks
 * the chosen one has the slot.
 */
export function staffHasSlot(
  candidates: Candidate[],
  staffId: string,
  startsAt: string,
): boolean {
  const c = candidates.find((x) => x.staffId === staffId);
  return c ? c.slots.some((s) => s.startsAt === startsAt) : false;
}

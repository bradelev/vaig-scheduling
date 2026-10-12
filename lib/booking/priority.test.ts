// Invented data only. Slots are ISO instants; durationMin is the service length.
import { describe, expect, it } from "vitest";
import { assignByPriority, mergedSlots, staffHasSlot, type Candidate } from "./priority";
import type { Slot } from "./slots";

const slot = (iso: string): Slot => ({ startsAt: iso, durationMin: 60 });

const T14 = "2026-09-04T17:00:00.000Z"; // 14:00 MVD
const T15 = "2026-09-04T18:00:00.000Z"; // 15:00 MVD
const T16 = "2026-09-04T19:00:00.000Z"; // 16:00 MVD

describe("assignByPriority", () => {
  it("picks the lowest-priority staff free at the time", () => {
    const cands: Candidate[] = [
      { staffId: "iara", priority: 3, slots: [slot(T14), slot(T15)] },
      { staffId: "lu", priority: 1, slots: [slot(T14)] }, // best priority, free at 14
      { staffId: "stephany", priority: 2, slots: [slot(T15)] },
    ];
    expect(assignByPriority(cands, T14)).toBe("lu"); // priority 1 wins
  });

  it("falls through to the next priority when the best isn't free then", () => {
    const cands: Candidate[] = [
      { staffId: "lu", priority: 1, slots: [slot(T14)] }, // not free at 15
      { staffId: "stephany", priority: 2, slots: [slot(T15)] }, // free at 15
      { staffId: "iara", priority: 3, slots: [slot(T15)] },
    ];
    expect(assignByPriority(cands, T15)).toBe("stephany"); // next best free at 15
  });

  it("returns null when nobody is free at that instant", () => {
    const cands: Candidate[] = [
      { staffId: "lu", priority: 1, slots: [slot(T14)] },
      { staffId: "iara", priority: 3, slots: [slot(T14)] },
    ];
    expect(assignByPriority(cands, T16)).toBeNull();
  });

  it("keeps Cynthia (high priority number) last but still assignable when alone", () => {
    const cands: Candidate[] = [
      { staffId: "cyn", priority: 99, slots: [slot(T16)] }, // only one free at 16
      { staffId: "lu", priority: 1, slots: [slot(T14)] },
    ];
    expect(assignByPriority(cands, T16)).toBe("cyn");
  });

  it("stable tiebreak by staffId when priorities are equal", () => {
    const cands: Candidate[] = [
      { staffId: "steph", priority: 100, slots: [slot(T14)] },
      { staffId: "angel", priority: 100, slots: [slot(T14)] },
    ];
    expect(assignByPriority(cands, T14)).toBe("angel"); // 'angel' < 'steph'
  });

  it("does not mutate the input order", () => {
    const cands: Candidate[] = [
      { staffId: "iara", priority: 3, slots: [slot(T14)] },
      { staffId: "lu", priority: 1, slots: [slot(T14)] },
    ];
    const snapshot = cands.map((c) => c.staffId);
    assignByPriority(cands, T14);
    expect(cands.map((c) => c.staffId)).toEqual(snapshot);
  });
});

describe("mergedSlots", () => {
  it("offers a time if ANY candidate is free then, ascending, de-duped", () => {
    const cands: Candidate[] = [
      { staffId: "lu", priority: 1, slots: [slot(T14), slot(T15)] },
      { staffId: "iara", priority: 3, slots: [slot(T15), slot(T16)] }, // T15 dup
    ];
    expect(mergedSlots(cands).map((s) => s.startsAt)).toEqual([T14, T15, T16]);
  });

  it("empty when no candidate has slots", () => {
    expect(mergedSlots([{ staffId: "lu", priority: 1, slots: [] }])).toEqual([]);
  });
});

describe("staffHasSlot", () => {
  const cands: Candidate[] = [
    { staffId: "iara", priority: 3, slots: [slot(T14), slot(T15)] },
  ];
  it("true when the chosen staff is free at the time", () => {
    expect(staffHasSlot(cands, "iara", T14)).toBe(true);
  });
  it("false when free at another time", () => {
    expect(staffHasSlot(cands, "iara", T16)).toBe(false);
  });
  it("false when the staff isn't a candidate", () => {
    expect(staffHasSlot(cands, "lu", T14)).toBe(false);
  });
});

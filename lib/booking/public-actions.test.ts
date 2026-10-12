// Invented data only.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state: { service: Row | null; serviceError: string | null; providers: Row[] } = {
  service: { duration_min: 60, active: true },
  serviceError: null,
  providers: [
    { staff_id: "lu", priority: 1 },
    { staff_id: "iara", priority: 3 },
  ],
};
vi.mock("next/headers", () => ({ headers: () => ({ get: () => "203.0.113.7" }) }));

const rateLimitAllowed = { value: true };
vi.mock("../supabase/service", () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: [{ allowed: rateLimitAllowed.value, retry_after_sec: rateLimitAllowed.value ? 0 : 60 }], error: null }),
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) b[m] = () => b;
      b.maybeSingle = () =>
        Promise.resolve(
          state.serviceError
            ? { data: null, error: { message: state.serviceError } }
            : { data: state.service, error: null },
        );
      b.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(table === "staff_services" ? { data: state.providers, error: null } : { data: null, error: null }).then(resolve);
      return b;
    },
  }),
}));

const getStaffAvailability = vi.fn();
vi.mock("./availability", () => ({
  getStaffAvailability: (...a: unknown[]) => getStaffAvailability(...a),
}));

import { fetchPublicWeek } from "./public-actions";

const SVC = "0b7a6a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const slot = (iso: string) => ({ startsAt: iso, durationMin: 60 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T13:00:00.000Z")); // Tuesday 10:00 Montevideo
  state.service = { duration_min: 60, active: true };
  state.serviceError = null;
  rateLimitAllowed.value = true;
  getStaffAvailability.mockReset();
  getStaffAvailability.mockImplementation(async (_db: unknown, q: { staffId: string; fromDayKey: string; days: number }) => {
    // lu: Wed 3/9 at 14:00 + 15:00; iara: Wed 3/9 at 14:00 + Thu 4/9 at 10:00
    const all: Record<string, { dayKey: string; slots: { startsAt: string; durationMin: number }[] }[]> = {
      lu: [{ dayKey: "2026-09-03", slots: [slot("2026-09-03T17:00:00.000Z"), slot("2026-09-03T18:00:00.000Z")] }],
      iara: [
        { dayKey: "2026-09-03", slots: [slot("2026-09-03T17:00:00.000Z")] },
        { dayKey: "2026-09-04", slots: [slot("2026-09-04T13:00:00.000Z")] },
      ],
    };
    return all[q.staffId] ?? [];
  });
});

describe("fetchPublicWeek — input", () => {
  it("rejects a non-uuid service and a malformed week without touching the DB", async () => {
    expect(await fetchPublicWeek({ serviceId: "x", mondayKey: "2026-08-31", staffId: null })).toEqual({ error: "Servicio inválido." });
    expect(await fetchPublicWeek({ serviceId: SVC, mondayKey: "31/08", staffId: null })).toEqual({ error: "Semana inválida." });
    expect(await fetchPublicWeek({ serviceId: SVC, mondayKey: "2026-99-99", staffId: null })).toEqual({ error: "Semana inválida." });
    expect(getStaffAvailability).not.toHaveBeenCalled();
  });

  it("an unknown / inactive service is the client's error; a read failure is generic", async () => {
    state.service = null;
    expect(await fetchPublicWeek({ serviceId: SVC, mondayKey: "2026-08-31", staffId: null })).toEqual({ error: "Ese servicio ya no está disponible." });
    state.service = { duration_min: 60, active: true };
    state.serviceError = "down";
    expect(await fetchPublicWeek({ serviceId: SVC, mondayKey: "2026-08-31", staffId: null })).toEqual({ error: "No pudimos cargar los horarios. Probá de nuevo." });
  });
});

describe("fetchPublicWeek — rate limit", () => {
  it("refuses a rate-limited IP before touching the catalog or the engine", async () => {
    rateLimitAllowed.value = false;
    expect(await fetchPublicWeek({ serviceId: SVC, mondayKey: "2026-08-31", staffId: null })).toEqual({
      error: "Demasiadas consultas seguidas. Esperá un momento y probá de nuevo.",
    });
    expect(getStaffAvailability).not.toHaveBeenCalled();
  });
});

describe("fetchPublicWeek — week", () => {
  it("merges every provider for 'con quien sea', one engine window per provider from today", async () => {
    const res = await fetchPublicWeek({ serviceId: SVC, mondayKey: "2026-08-31", staffId: null });
    if ("error" in res) throw new Error(res.error);
    expect(res.days.map((d) => d.dayKey)).toEqual([
      "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06",
    ]);
    expect(res.days[0].slots).toEqual([]); // Monday is past
    expect(res.days[3].slots).toEqual(["2026-09-03T17:00:00.000Z", "2026-09-03T18:00:00.000Z"]); // merged, deduped
    expect(res.days[4].slots).toEqual(["2026-09-04T13:00:00.000Z"]);
    // 2 providers → 2 engine calls, each spanning today (Tue) .. Sunday = 6 days
    expect(getStaffAvailability).toHaveBeenCalledTimes(2);
    expect(getStaffAvailability.mock.calls[0][1]).toMatchObject({ fromDayKey: "2026-09-01", days: 6, durationMin: 60 });
  });

  it("a chosen professional only shows their own slots", async () => {
    const res = await fetchPublicWeek({ serviceId: SVC, mondayKey: "2026-08-31", staffId: "iara" });
    if ("error" in res) throw new Error(res.error);
    expect(res.days[3].slots).toEqual(["2026-09-03T17:00:00.000Z"]);
    expect(getStaffAvailability).toHaveBeenCalledTimes(1);
  });

  it("a staff who doesn't provide the item → an empty week, no engine call", async () => {
    const res = await fetchPublicWeek({ serviceId: SVC, mondayKey: "2026-08-31", staffId: "cyn" });
    if ("error" in res) throw new Error(res.error);
    expect(res.days.every((d) => d.slots.length === 0)).toBe(true);
    expect(getStaffAvailability).not.toHaveBeenCalled();
  });

  it("a week entirely in the past or beyond the horizon is empty without hitting the DB", async () => {
    const past = await fetchPublicWeek({ serviceId: SVC, mondayKey: "2026-08-17", staffId: null });
    const far = await fetchPublicWeek({ serviceId: SVC, mondayKey: "2027-01-04", staffId: null });
    for (const r of [past, far]) {
      if ("error" in r) throw new Error(r.error);
      expect(r.days.every((d) => d.slots.length === 0)).toBe(true);
    }
    expect(getStaffAvailability).not.toHaveBeenCalled();
  });

  it("filters slots by the exact instant horizon (parity with /api/reservar)", async () => {
    // Day +60 from 2026-09-01 is 2026-10-31 (Saturday); now is 10:00 local → a
    // 09:00 slot that day is inside, a 14:00 slot is outside.
    getStaffAvailability.mockImplementation(async () => [
      { dayKey: "2026-10-31", slots: [slot("2026-10-31T12:00:00.000Z"), slot("2026-10-31T17:00:00.000Z")] },
    ]);
    const res = await fetchPublicWeek({ serviceId: SVC, mondayKey: "2026-10-26", staffId: null });
    if ("error" in res) throw new Error(res.error);
    expect(res.days.find((d) => d.dayKey === "2026-10-31")?.slots).toEqual(["2026-10-31T12:00:00.000Z"]);
  });
});

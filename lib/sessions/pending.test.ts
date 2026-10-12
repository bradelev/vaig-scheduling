// Invented data only.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPendingReservations } from "./pending";

/** A fake client whose sessions query resolves to the given rows (or error). */
function fakeDb(result: { data?: unknown[]; error?: string }): SupabaseClient {
  const res = result.error
    ? { data: null, error: { message: result.error } }
    : { data: result.data ?? [], error: null };
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order"]) b[m] = () => b;
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(res).then(resolve);
  return { from: () => b } as unknown as SupabaseClient;
}

const NOW = Date.parse("2026-09-07T13:00:00.000Z");
const base = {
  id: "s1",
  starts_at: "2026-09-07T17:00:00.000Z",
  ends_at: "2026-09-07T18:00:00.000Z",
  service: "depilacion",
  note: "Reserva online: Pierna entera",
  attended_by: "lu",
  created_at: "2026-09-06T10:00:00.000Z",
};

describe("fetchPendingReservations — mapping", () => {
  it("maps object embeds (PostgREST many-to-one) into the panel shape", async () => {
    const db = fakeDb({
      data: [{
        ...base,
        clients: { full_name: "Ana Prueba", phone: "+59891234567" },
        booking_services: { name: "Pierna entera" },
        client_packages: { total_sessions: 6, used_sessions: 2, status: "pendiente_pago" },
      }],
    });
    const res = await fetchPendingReservations(db, NOW);
    expect(res).toEqual({
      items: [
        {
          id: "s1",
          startsAt: base.starts_at,
          endsAt: base.ends_at,
          clientName: "Ana Prueba",
          clientPhone: "+59891234567",
          serviceName: "Pierna entera",
          staffId: "lu",
          createdAt: base.created_at,
          stale: false,
          pkg: { total: 6, used: 2, unpaid: true },
        },
      ],
    });
  });

  it("accepts array embeds too (the generic types say array)", async () => {
    const db = fakeDb({
      data: [{ ...base, clients: [{ full_name: "Ana Prueba", phone: null }], booking_services: [{ name: "Pierna entera" }] }],
    });
    const res = await fetchPendingReservations(db, NOW);
    if ("error" in res) throw new Error(res.error);
    expect(res.items[0].clientName).toBe("Ana Prueba");
    expect(res.items[0].clientPhone).toBeNull();
    expect(res.items[0].serviceName).toBe("Pierna entera");
  });

  it("falls back item name → note → service slug → '(sin servicio)'", async () => {
    const rows = [
      { ...base, id: "a", clients: null, booking_services: null }, // note
      { ...base, id: "b", note: null, clients: null, booking_services: null }, // slug
      { ...base, id: "c", note: null, service: null, clients: null, booking_services: null },
    ];
    const res = await fetchPendingReservations(fakeDb({ data: rows }), NOW);
    if ("error" in res) throw new Error(res.error);
    expect(res.items.map((i) => i.serviceName)).toEqual([
      "Reserva online: Pierna entera",
      "depilacion",
      "(sin servicio)",
    ]);
    expect(res.items[0].clientName).toBe("(sin nombre)");
  });

  it("flags a reservation whose start already passed as stale", async () => {
    const res = await fetchPendingReservations(
      fakeDb({ data: [{ ...base, starts_at: "2026-09-07T12:00:00.000Z", clients: null, booking_services: null }] }),
      NOW,
    );
    if ("error" in res) throw new Error(res.error);
    expect(res.items[0].stale).toBe(true);
  });

  it("surfaces a read error instead of an empty list", async () => {
    expect(await fetchPendingReservations(fakeDb({ error: "permission denied" }), NOW)).toEqual({
      error: "permission denied",
    });
  });
});

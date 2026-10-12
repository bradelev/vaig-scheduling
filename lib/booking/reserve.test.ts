// Invented data only.
import { describe, expect, it, vi } from "vitest";
import {
  cleanClientName,
  looksLikeUuid,
  MAX_BOOKING_HORIZON_DAYS,
  MAX_CLIENT_NAME_LENGTH,
  MAX_PENDING_RESERVATIONS,
  reserve,
  SlotTakenError,
  verifiedPhone,
  withinBookingHorizon,
  type ReservePorts,
  type ReserveRequest,
} from "./reserve";
import type { Candidate } from "./priority";

const PHONE = verifiedPhone("+59891234567");
const IDENTITY = { phone: PHONE };
const T14 = "2026-09-04T17:00:00.000Z";
const T16 = "2026-09-04T19:00:00.000Z";

const slot = (iso: string) => ({ startsAt: iso, durationMin: 60 });
const free = (staffId: string, priority: number, ...at: string[]): Candidate => ({
  staffId,
  priority,
  slots: at.map(slot),
});

function ports(over: Partial<ReservePorts> = {}, candidates: Candidate[] = []): ReservePorts {
  return {
    serviceAvailability: vi.fn(async () => ({
      name: "Pierna entera",
      category: "Depilación Láser",
      durationMin: 60,
      packageSessions: null,
      candidates,
    })),
    clientForPhone: vi.fn(async () => ({ id: "client-1", name: "Cliente Test" })),
    pendingReservationCount: vi.fn(async () => 0),
    takePackageCredit: vi.fn(async () => ({ id: "pkg-new", total: 6, used: 1, created: true })),
    refundCredit: vi.fn(async () => {}),
    deletePackage: vi.fn(async () => true),
    insertSession: vi.fn(async () => ({ sessionId: "sess-1" })),
    notifyStaff: vi.fn(async () => {}),
    ...over,
  };
}

const baseRequest: ReserveRequest = {
  serviceId: "svc-1",
  startsAt: T14,
  dayKey: "2026-09-04",
  staffId: null,
  clientName: null,
};

const insertedRow = (p: ReservePorts) =>
  (p.insertSession as ReturnType<typeof vi.fn>).mock.calls[0][0];

describe("reserve — con quien sea", () => {
  it("assigns the first free staff by priority and inserts a pending session", async () => {
    const p = ports({}, [free("lu", 1, T14), free("iara", 3, T14)]);
    const res = await reserve(IDENTITY, baseRequest, p);
    expect(res).toEqual({ ok: true, sessionId: "sess-1", attendedBy: "lu" });
    const row = insertedRow(p);
    expect(row.attendedBy).toBe("lu");
    expect(row.clientId).toBe("client-1");
    expect(row.service).toBe("depilacion"); // mapped from "Depilación Láser"
    expect(row.endsAt).toBe("2026-09-04T18:00:00.000Z"); // +60 min
    expect(row.pendingConfirmation).toBe(true); // born "por confirmar"
    expect(row.bookingServiceId).toBe("svc-1"); // linked to the catalog item
    expect(p.notifyStaff).toHaveBeenCalledOnce();
  });

  it("returns unavailable when nobody is free at the slot", async () => {
    const p = ports({}, [free("lu", 1, T16)]);
    const res = await reserve(IDENTITY, baseRequest, p); // wants T14, only T16 free
    expect(res).toEqual({ ok: false, reason: "unavailable" });
    expect(p.insertSession).not.toHaveBeenCalled();
  });

  it("an unmapped category stores service null (uncategorized, still valid)", async () => {
    const p = ports(
      {
        serviceAvailability: vi.fn(async () => ({
          name: "Day Spa Relax",
          category: "Day Spa",
          durationMin: 90,
          packageSessions: null,
          candidates: [free("lu", 1, T14)],
        })),
      },
    );
    await reserve(IDENTITY, baseRequest, p);
    expect(insertedRow(p).service).toBeNull();
    expect(insertedRow(p).endsAt).toBe("2026-09-04T18:30:00.000Z"); // +90 min
  });
});

describe("reserve — direct choice", () => {
  it("honors the chosen professional when they're free", async () => {
    const p = ports({}, [free("lu", 1, T14), free("iara", 3, T14)]);
    const res = await reserve(IDENTITY, { ...baseRequest, staffId: "iara" }, p);
    expect(res).toEqual({ ok: true, sessionId: "sess-1", attendedBy: "iara" });
  });

  it("returns unavailable if the chosen professional isn't free then", async () => {
    const p = ports({}, [free("iara", 3, T16)]);
    const res = await reserve(IDENTITY, { ...baseRequest, staffId: "iara" }, p);
    expect(res).toEqual({ ok: false, reason: "unavailable" });
  });

  it("returns unavailable for a staffId who doesn't provide the service (not a candidate)", async () => {
    const p = ports({}, [free("lu", 1, T14)]);
    const res = await reserve(IDENTITY, { ...baseRequest, staffId: "cyn" }, p);
    expect(res).toEqual({ ok: false, reason: "unavailable" });
    expect(p.insertSession).not.toHaveBeenCalled();
  });
});

describe("reserve — the service name comes from the DB, never the client", () => {
  it("note and staff notice use the DB name", async () => {
    const p = ports({}, [free("lu", 1, T14)]);
    await reserve(IDENTITY, baseRequest, p);
    expect(insertedRow(p).note).toBe("Reserva online: Pierna entera");
    expect(p.notifyStaff).toHaveBeenCalledWith(
      expect.objectContaining({ serviceName: "Pierna entera", clientName: "Cliente Test" }),
    );
  });
});

describe("reserve — pending cap", () => {
  it(`refuses when the client already has ${MAX_PENDING_RESERVATIONS} pending reservations`, async () => {
    const p = ports(
      { pendingReservationCount: vi.fn(async () => MAX_PENDING_RESERVATIONS) },
      [free("lu", 1, T14)],
    );
    const res = await reserve(IDENTITY, baseRequest, p);
    expect(res).toEqual({ ok: false, reason: "limit" });
    expect(p.insertSession).not.toHaveBeenCalled();
    expect(p.notifyStaff).not.toHaveBeenCalled();
  });

  it("allows one below the cap", async () => {
    const p = ports(
      { pendingReservationCount: vi.fn(async () => MAX_PENDING_RESERVATIONS - 1) },
      [free("lu", 1, T14)],
    );
    const res = await reserve(IDENTITY, baseRequest, p);
    expect(res.ok).toBe(true);
  });
});

describe("reserve — cuponera (prepaid package)", () => {
  const packageAvail = (candidates: Candidate[]) =>
    vi.fn(async () => ({
      name: "Cuponera media pierna",
      category: "Cuponeras de Depilación Láser",
      durationMin: 30,
      packageSessions: 6,
      candidates,
    }));

  it("a single-session item never touches the package ports", async () => {
    const p = ports({}, [free("lu", 1, T14)]);
    const res = await reserve(IDENTITY, baseRequest, p);
    expect(res).toEqual({ ok: true, sessionId: "sess-1", attendedBy: "lu" });
    expect(p.takePackageCredit).not.toHaveBeenCalled();
    expect(insertedRow(p).packageId).toBeNull();
  });

  it("first purchase: creates the package with its first credit used and links the session", async () => {
    const p = ports({ serviceAvailability: packageAvail([free("lu", 1, T14)]) });
    const res = await reserve(IDENTITY, baseRequest, p);
    expect(p.takePackageCredit).toHaveBeenCalledWith("client-1", "svc-1", 6);
    expect(insertedRow(p).packageId).toBe("pkg-new");
    expect(res).toEqual({
      ok: true,
      sessionId: "sess-1",
      attendedBy: "lu",
      package: { id: "pkg-new", total: 6, remaining: 5 },
    });
  });

  it("existing balance: takes one credit, no new package", async () => {
    const p = ports({
      serviceAvailability: packageAvail([free("lu", 1, T14)]),
      takePackageCredit: vi.fn(async () => ({ id: "pkg-1", total: 6, used: 3, created: false })),
    });
    const res = await reserve(IDENTITY, baseRequest, p);
    expect(insertedRow(p).packageId).toBe("pkg-1");
    expect(res).toMatchObject({ ok: true, package: { id: "pkg-1", total: 6, remaining: 3 } });
  });

  it("slot taken after the credit was consumed → the credit is returned", async () => {
    const p = ports({
      serviceAvailability: packageAvail([free("lu", 1, T14)]),
      takePackageCredit: vi.fn(async () => ({ id: "pkg-1", total: 6, used: 3, created: false })),
      insertSession: vi.fn(async () => { throw new SlotTakenError(); }),
    });
    expect(await reserve(IDENTITY, baseRequest, p)).toEqual({ ok: false, reason: "taken" });
    expect(p.refundCredit).toHaveBeenCalledWith("pkg-1");
    expect(p.deletePackage).not.toHaveBeenCalled();
  });

  it("slot taken on a first purchase → the just-created package is removed", async () => {
    const p = ports({
      serviceAvailability: packageAvail([free("lu", 1, T14)]),
      insertSession: vi.fn(async () => { throw new SlotTakenError(); }),
    });
    expect(await reserve(IDENTITY, baseRequest, p)).toEqual({ ok: false, reason: "taken" });
    expect(p.deletePackage).toHaveBeenCalledWith("pkg-new");
    expect(p.refundCredit).not.toHaveBeenCalled();
  });

  it("first purchase, slot taken, but someone already drew from the new package → refund instead of delete", async () => {
    const p = ports({
      serviceAvailability: packageAvail([free("lu", 1, T14)]),
      insertSession: vi.fn(async () => { throw new SlotTakenError(); }),
      deletePackage: vi.fn(async () => false),
    });
    expect(await reserve(IDENTITY, baseRequest, p)).toEqual({ ok: false, reason: "taken" });
    expect(p.refundCredit).toHaveBeenCalledWith("pkg-new");
  });

  it("no credit is taken when the slot isn't free or the cap is hit", async () => {
    const p = ports({
      serviceAvailability: packageAvail([free("lu", 1, T16)]),
      pendingReservationCount: vi.fn(async () => MAX_PENDING_RESERVATIONS),
    });
    await reserve(IDENTITY, baseRequest, p); // unavailable
    expect(p.takePackageCredit).not.toHaveBeenCalled();
    const p2 = ports({
      serviceAvailability: packageAvail([free("lu", 1, T14)]),
      pendingReservationCount: vi.fn(async () => MAX_PENDING_RESERVATIONS),
    });
    expect(await reserve(IDENTITY, baseRequest, p2)).toEqual({ ok: false, reason: "limit" });
    expect(p2.takePackageCredit).not.toHaveBeenCalled();
  });
});

describe("reserve — safety", () => {
  it("returns 'taken' ONLY on the double-booking constraint (SlotTakenError)", async () => {
    const p = ports(
      { insertSession: vi.fn(async () => { throw new SlotTakenError(); }) },
      [free("lu", 1, T14)],
    );
    const res = await reserve(IDENTITY, baseRequest, p);
    expect(res).toEqual({ ok: false, reason: "taken" });
    expect(p.notifyStaff).not.toHaveBeenCalled(); // no notify on a failed insert
  });

  it("a non-constraint insert error propagates — NOT mis-reported as 'taken'", async () => {
    // An RLS denial / connection drop must surface as a real failure, not hide
    // behind a misleading "slot taken" message.
    const p = ports(
      { insertSession: vi.fn(async () => { throw new Error("permission denied for table sessions"); }) },
      [free("lu", 1, T14)],
    );
    await expect(reserve(IDENTITY, baseRequest, p)).rejects.toThrow("permission denied");
    expect(p.notifyStaff).not.toHaveBeenCalled();
  });

  it("identifies the client by the verified phone and passes the name only for creation", async () => {
    const p = ports({}, [free("lu", 1, T14)]);
    await reserve(IDENTITY, { ...baseRequest, clientName: "Ana Prueba" }, p);
    expect(p.clientForPhone).toHaveBeenCalledWith(PHONE, "Ana Prueba");
  });

  it("the booking stands even if the staff notify fails", async () => {
    const p = ports(
      { notifyStaff: vi.fn(async () => { throw new Error("whatsapp down"); }) },
      [free("lu", 1, T14)],
    );
    const res = await reserve(IDENTITY, baseRequest, p);
    expect(res).toEqual({ ok: true, sessionId: "sess-1", attendedBy: "lu" });
  });

  it("invalid when the service doesn't exist / is inactive", async () => {
    const p = ports({ serviceAvailability: vi.fn(async () => null) });
    const res = await reserve(IDENTITY, baseRequest, p);
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });

  it("a garbage startsAt is 'unavailable' — never throws on the Date math", async () => {
    const p = ports({}, [free("lu", 1, T14)]);
    const res = await reserve(IDENTITY, { ...baseRequest, startsAt: "not-a-date" }, p);
    expect(res).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("withinBookingHorizon", () => {
  const now = Date.parse("2026-09-01T12:00:00Z");
  const day = 86_400_000;
  it("accepts a future start inside the horizon", () => {
    expect(withinBookingHorizon(now + 3 * day, now)).toBe(true);
    expect(withinBookingHorizon(now + MAX_BOOKING_HORIZON_DAYS * day, now)).toBe(true);
  });
  it("rejects the past, now, beyond the horizon, and NaN", () => {
    expect(withinBookingHorizon(now - 1, now)).toBe(false);
    expect(withinBookingHorizon(now, now)).toBe(false);
    expect(withinBookingHorizon(now + MAX_BOOKING_HORIZON_DAYS * day + 1, now)).toBe(false);
    expect(withinBookingHorizon(NaN, now)).toBe(false);
  });
});

describe("looksLikeUuid", () => {
  it("accepts a uuid in either case", () => {
    expect(looksLikeUuid("0b7a6a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(looksLikeUuid("0B7A6A4E-1C2D-4E5F-8A9B-0C1D2E3F4A5B")).toBe(true);
  });
  it("rejects anything else (Postgres would 22P02 on it)", () => {
    expect(looksLikeUuid("x")).toBe(false);
    expect(looksLikeUuid("")).toBe(false);
    expect(looksLikeUuid("0b7a6a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5")).toBe(false);
  });
});

describe("cleanClientName", () => {
  it("trims, collapses whitespace incl. newlines/tabs (Meta rejects them in params)", () => {
    expect(cleanClientName("  Ana \n\t  Prueba  ")).toBe("Ana Prueba");
  });
  it("strips control and format characters (NUL, zero-width, bidi)", () => {
    expect(cleanClientName("Ana\u0000 \u200bPru\u202eeba")).toBe("Ana Prueba");
  });
  it("bounds by code points without splitting a surrogate pair", () => {
    const long = "A".repeat(MAX_CLIENT_NAME_LENGTH - 1) + "😀B";
    const out = cleanClientName(long)!;
    expect(Array.from(out).length).toBe(MAX_CLIENT_NAME_LENGTH);
    expect(out.endsWith("😀")).toBe(true);
    expect(out.includes("\uFFFD")).toBe(false);
  });
  it("empty / non-string → null", () => {
    expect(cleanClientName("   ")).toBeNull();
    expect(cleanClientName("\u200b")).toBeNull();
    expect(cleanClientName(42)).toBeNull();
    expect(cleanClientName(undefined)).toBeNull();
  });
});

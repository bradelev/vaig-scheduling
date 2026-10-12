import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyNewReservation, staffDateTimeLabel } from "./notify-staff";

/** A fake Supabase client whose staff lookup returns the given phone (or error). */
function fakeDb(staff: { phone?: string | null; error?: string }): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            staff.error
              ? { data: null, error: { message: staff.error } }
              : { data: { phone: staff.phone ?? null }, error: null },
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

const STAFF_PHONE = "+59891234567";

describe("staffDateTimeLabel — Montevideo wall-clock, Spanish", () => {
  it("formats an afternoon instant as 'weekday d/m a las HH:mm'", () => {
    // 2026-09-07 17:00 UTC = 14:00 Montevideo (fixed -03:00). Sept 7 2026 = Monday.
    expect(staffDateTimeLabel("2026-09-07T17:00:00.000Z")).toBe("lunes 7/9 a las 14:00");
  });

  it("uses Montevideo, not UTC, for the day boundary", () => {
    // 2026-09-08 01:30 UTC is still 2026-09-07 22:30 in Montevideo.
    expect(staffDateTimeLabel("2026-09-08T01:30:00.000Z")).toBe("lunes 7/9 a las 22:30");
  });

  it("pads the time and keeps 24h", () => {
    // 2026-09-05 12:05 UTC = 09:05 Montevideo. Sept 5 2026 = Saturday.
    expect(staffDateTimeLabel("2026-09-05T12:05:00.000Z")).toBe("sábado 5/9 a las 09:05");
  });
});

describe("notifyNewReservation", () => {
  const OLD_ENV = process.env.CLIENT_AUTH_TEST_MODE;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.CLIENT_AUTH_TEST_MODE = "1"; // stub mode — never hit Meta
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.CLIENT_AUTH_TEST_MODE;
    else process.env.CLIENT_AUTH_TEST_MODE = OLD_ENV;
    info.mockRestore();
  });

  const input = {
    staffId: "lu",
    clientName: "Ana Pérez",
    serviceName: "Pierna entera",
    startsAt: "2026-09-07T17:00:00.000Z",
  };

  it("returns silently when the staff has no phone on file (no send, no throw)", async () => {
    await expect(
      notifyNewReservation(fakeDb({ phone: null }), input),
    ).resolves.toBeUndefined();
    expect(info).not.toHaveBeenCalled();
  });

  it("in stub mode logs last-4 of the phone only — never the full number", async () => {
    await notifyNewReservation(fakeDb({ phone: STAFF_PHONE }), input);
    const logged = info.mock.calls[0]?.[0] as string;
    expect(logged).toContain("...4567");
    expect(logged).not.toContain(STAFF_PHONE); // full E.164 must not appear
    expect(logged).not.toContain("5989123"); // nor the leading digits
  });

  it("logs the params in template order: client | service | date", async () => {
    await notifyNewReservation(fakeDb({ phone: STAFF_PHONE }), input);
    const logged = info.mock.calls[0]?.[0] as string;
    expect(logged).toContain("Ana Pérez | Pierna entera | lunes 7/9 a las 14:00");
  });

  it("falls back to 'una clienta' when the client name is null/blank", async () => {
    await notifyNewReservation(fakeDb({ phone: STAFF_PHONE }), { ...input, clientName: "  " });
    expect(info.mock.calls[0]?.[0] as string).toContain("una clienta | Pierna entera");
  });

  it("throws when the staff lookup itself fails (surfaced, not swallowed here)", async () => {
    await expect(
      notifyNewReservation(fakeDb({ error: "db down" }), input),
    ).rejects.toThrow("db down");
  });
});

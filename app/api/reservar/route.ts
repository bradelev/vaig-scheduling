/**
 * POST /api/reservar — the public online booking write (Phase 2). A
 * phone-verified client reserves a slot for a service, optionally with a chosen
 * professional; the reservation lands "por confirmar" (pending_confirmation)
 * and the assigned professional is notified.
 *
 * SECURITY — the client is identified by their VERIFIED-PHONE SESSION, never by
 * request input. We read app_metadata.phone (admin-only, unforgeable) from the
 * JWT via getUser(); a caller cannot book "as" another client. Anon → 401. The
 * body carries only what the client may choose: service, slot, professional,
 * and their own name for a first booking (bounded; never overwrites a known
 * client's name). The service NAME is never taken from the body — it comes
 * from the DB, so nothing client-typed reaches the agenda or the staff notice.
 *
 * The pure decision + write lives in lib/booking/reserve.ts (availability
 * re-check, professional assignment, pending cap, insert relying on the
 * exclusion constraint for atomic no-double-book); the real I/O is
 * lib/booking/reserve-ports.ts.
 */
import { NextResponse } from "next/server";
import { clientIpFrom, hitRateLimit, RATE_LIMITS, rateLimitedResponse } from "@/lib/security/rate-limit";
import { serviceClient } from "@/lib/supabase/service";
import {
  cleanClientName,
  looksLikeUuid,
  MAX_BOOKING_HORIZON_DAYS,
  MAX_PENDING_RESERVATIONS,
  reserve,
  verifiedPhone,
  withinBookingHorizon,
  type ReserveRequest,
} from "@/lib/booking/reserve";
import { makeReservePorts } from "@/lib/booking/reserve-ports";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** ISO instant → Montevideo YYYY-MM-DD (the dayKey the availability read wants). */
function dayKeyOf(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export async function POST(request: Request) {
  // Per-IP limit first — before any parsing or work (bounds reservation spam from one source).
  const limited = await hitRateLimit(serviceClient(), RATE_LIMITS.reserve, clientIpFrom(request.headers));
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSec);

  // 1. The verified client — from the session, NOT the body.
  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();
  const phone = (userData.user?.app_metadata as { phone?: unknown } | undefined)?.phone;
  if (typeof phone !== "string" || !phone) {
    return NextResponse.json({ error: "Iniciá sesión para reservar." }, { status: 401 });
  }
  const identity = { phone: verifiedPhone(phone) };

  // 2. The request.
  let body: {
    serviceId?: unknown;
    startsAt?: unknown;
    staffId?: unknown;
    name?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 });
  }
  const serviceId = typeof body.serviceId === "string" ? body.serviceId : "";
  const startsAt = typeof body.startsAt === "string" ? body.startsAt : "";
  const staffId = typeof body.staffId === "string" && body.staffId ? body.staffId : null;
  // serviceId must be uuid-shaped (a malformed id is the client's 400, not a
  // Postgres 22P02 surfacing as our 500); startsAt must be a valid instant.
  const startMs = startsAt ? Date.parse(startsAt) : NaN;
  if (!looksLikeUuid(serviceId) || Number.isNaN(startMs)) {
    return NextResponse.json({ error: "Datos de la reserva incompletos." }, { status: 400 });
  }
  const nowMs = Date.now();
  if (!withinBookingHorizon(startMs, nowMs)) {
    return NextResponse.json(
      { error: `Solo se puede reservar hasta ${MAX_BOOKING_HORIZON_DAYS} días hacia adelante.` },
      { status: 400 },
    );
  }
  // Normalize to a canonical ISO instant so the slot compare matches exactly.
  const startsAtIso = new Date(startMs).toISOString();

  const req: ReserveRequest = {
    serviceId,
    startsAt: startsAtIso,
    dayKey: dayKeyOf(startsAtIso),
    staffId,
    clientName: cleanClientName(body.name),
  };

  try {
    const ports = makeReservePorts({ nowMs });
    const res = await reserve(identity, req, ports);
    if (res.ok) {
      // The reservation completed: this phone is no longer "a medio camino".
      // Best-effort — the queue self-expires in 14 days anyway.
      try {
        await serviceClient().from("booking_recovery").delete().eq("phone", identity.phone);
      } catch {
        // Never let queue cleanup fail a successful reservation.
      }
      return NextResponse.json(
        { ok: true, sessionId: res.sessionId, ...(res.package ? { package: res.package } : {}) },
        { status: 201 },
      );
    }
    switch (res.reason) {
      case "taken":
        // Someone booked that exact slot first — the client should pick another.
        return NextResponse.json(
          { error: "Ese horario se acaba de reservar. Elegí otro." },
          { status: 409 },
        );
      case "unavailable":
        return NextResponse.json(
          { error: "Ese horario ya no está disponible." },
          { status: 409 },
        );
      case "limit":
        return NextResponse.json(
          {
            error:
              `Ya tenés ${MAX_PENDING_RESERVATIONS} reservas pendientes de confirmar. ` +
              "Cuando el equipo las confirme vas a poder reservar de nuevo.",
          },
          { status: 429 },
        );
      case "invalid":
        return NextResponse.json({ error: "El servicio no está disponible." }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "No se pudo crear la reserva." }, { status: 500 });
  }
}

/**
 * POST /api/reservar/interes — the "reservas a medio camino" capture
 * (docs/booking-analytics.md). ONLY for a phone-VERIFIED session: identity
 * comes from the JWT (app_metadata.phone), never the body — same posture as
 * /api/reservar. Upserts one row per phone with the latest intent (service +
 * slot being looked at); a completed reservation deletes it (see the reserve
 * route). Staff work the queue by hand from Métricas — no automated sends.
 */
import { NextResponse } from "next/server";
import { clientIpFrom, hitRateLimit, RATE_LIMITS, rateLimitedResponse } from "@/lib/security/rate-limit";
import { serviceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { looksLikeUuid } from "@/lib/booking/reserve";

export const dynamic = "force-dynamic";

const SWEEP_PROBABILITY = 0.02;
const RETENTION_DAYS = 14;

export async function POST(request: Request) {
  const db = serviceClient();
  const limited = await hitRateLimit(db, RATE_LIMITS.interes, clientIpFrom(request.headers));
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSec);

  // Verified phone from the session cookie — anonymous callers get a 401 and
  // no row is ever written for them.
  let phone: string | null = null;
  try {
    const { data } = await createClient().auth.getUser();
    const p = (data.user?.app_metadata as { phone?: unknown } | undefined)?.phone;
    phone = typeof p === "string" && p ? p : null;
  } catch {
    phone = null;
  }
  if (!phone) return new NextResponse(null, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const raw = (body ?? {}) as Record<string, unknown>;
  const serviceId =
    typeof raw.serviceId === "string" && looksLikeUuid(raw.serviceId) ? raw.serviceId : null;
  const slotAt =
    typeof raw.slotAt === "string" && !Number.isNaN(Date.parse(raw.slotAt))
      ? new Date(raw.slotAt).toISOString()
      : null;

  const { data: client } = await db.from("clients").select("id").eq("phone", phone).maybeSingle();

  const { error } = await db.from("booking_recovery").upsert(
    {
      phone,
      client_id: (client?.id as string | undefined) ?? null,
      booking_service_id: serviceId,
      slot_at: slotAt,
      updated_at: new Date().toISOString(),
      // A fresh intent re-opens the row for the team even if an older one was
      // already contacted.
      contacted_at: null,
    },
    { onConflict: "phone" },
  );
  if (error) {
    console.error(`booking_recovery upsert failed: ${error.message}`);
  }

  if (Math.random() < SWEEP_PROBABILITY) {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
    await db.from("booking_recovery").delete().lt("updated_at", cutoff);
  }

  return new NextResponse(null, { status: 204 });
}

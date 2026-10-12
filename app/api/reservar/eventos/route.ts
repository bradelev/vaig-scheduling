/**
 * POST /api/reservar/eventos — anonymous public-funnel event intake
 * (docs/booking-analytics.md). Fire-and-forget from BookingFlow: NOTHING here
 * may affect the booking flow, so every failure is swallowed into a generic
 * status and the client never waits on semantics. Strictly validated
 * (lib/analytics/events), per-IP rate limited, and events NEVER carry a phone
 * or a name — session_key is a random browser UUID.
 */
import { NextResponse } from "next/server";
import { clientIpFrom, hitRateLimit, RATE_LIMITS, rateLimitedResponse } from "@/lib/security/rate-limit";
import { serviceClient } from "@/lib/supabase/service";
import { validateTrackedEvent } from "@/lib/analytics/events";

export const dynamic = "force-dynamic";

/** Opportunistic retention sweep (the rate_limit_hit pattern): ~0.5% of
 *  inserts delete events older than 180 days — no cron needed. */
const SWEEP_PROBABILITY = 0.005;
const RETENTION_DAYS = 180;

export async function POST(request: Request) {
  const db = serviceClient();
  const limited = await hitRateLimit(db, RATE_LIMITS.eventos, clientIpFrom(request.headers));
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSec);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const validated = validateTrackedEvent(body);
  if ("error" in validated) return new NextResponse(null, { status: 400 });

  const { error } = await db.from("booking_events").insert(validated.row);
  if (error) {
    // Analytics must never look like an outage to the client; log scope only.
    console.error(`booking_events insert failed: ${error.message}`);
  }

  if (Math.random() < SWEEP_PROBABILITY) {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
    await db.from("booking_events").delete().lt("created_at", cutoff);
    await db.from("panel_events").delete().lt("created_at", cutoff);
  }

  return new NextResponse(null, { status: 204 });
}

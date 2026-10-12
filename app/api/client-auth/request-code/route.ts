/**
 * POST /api/client-auth/request-code — public endpoint that issues a login code
 * to a phone via WhatsApp (Phase 1 slice 3b). Anon-reachable (added to
 * PUBLIC_PREFIXES). The security logic lives in lib/client-auth/flow.ts; this
 * is thin: parse + normalize the phone, build the real ports, call requestCode,
 * and ALWAYS return a generic result (anti-enumeration — never reveal whether
 * the phone is a known client or was rate-limited-because-known).
 */
import { NextResponse } from "next/server";
import { clientIpFrom, hitRateLimit, RATE_LIMITS, rateLimitedResponse } from "@/lib/security/rate-limit";
import { serviceClient } from "@/lib/supabase/service";
import { normalizePhoneIntl } from "@/lib/clients/phone";
import { requestCode } from "@/lib/client-auth/flow";
import { makePorts } from "@/lib/client-auth/ports";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Per-IP limit first — before any parsing or work (each hit costs a WhatsApp message).
  const limited = await hitRateLimit(serviceClient(), RATE_LIMITS.requestCode, clientIpFrom(request.headers));
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSec);

  let phoneRaw: unknown;
  try {
    const body = await request.json();
    phoneRaw = body?.phone;
  } catch {
    return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 });
  }

  const phone = normalizePhoneIntl(typeof phoneRaw === "string" ? phoneRaw : "");
  if (!phone) {
    return NextResponse.json({ error: "El teléfono no es válido." }, { status: 400 });
  }

  try {
    const ports = makePorts({ nowMs: Date.now() });
    const res = await requestCode(phone, ports);
    // Anti-enumeration: a rate-limited response is the only non-ok we surface,
    // and it says nothing about client existence. Everything else → generic ok.
    if (!res.ok) {
      return NextResponse.json(
        { error: "Demasiados intentos. Probá de nuevo en unos minutos." },
        { status: 429 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch {
    // Never leak internals. A send/DB failure is a generic 500.
    return NextResponse.json({ error: "No se pudo enviar el código." }, { status: 500 });
  }
}

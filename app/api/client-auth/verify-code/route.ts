/**
 * POST /api/client-auth/verify-code — public endpoint that verifies a login
 * code and, on success, establishes the client's browser SESSION (Phase 1
 * slice 3b). Anon-reachable. The verify logic (attempt burn, constant-time
 * compare, single-use) lives in lib/client-auth/flow.ts; the session mint lives
 * in the port's establishSession, which hands the minted tokens back here via
 * onSessionToken so we can set the cookies with the @supabase/ssr server client
 * (a cookie op that must live in the route).
 *
 * Every failure returns the SAME generic result — never reveal which reason
 * (wrong / expired / exhausted / no code) to avoid oracles.
 */
import { NextResponse } from "next/server";
import { clientIpFrom, hitRateLimit, RATE_LIMITS, rateLimitedResponse } from "@/lib/security/rate-limit";
import { serviceClient } from "@/lib/supabase/service";
import { normalizePhoneIntl } from "@/lib/clients/phone";
import { verifyCode } from "@/lib/client-auth/flow";
import { makePorts } from "@/lib/client-auth/ports";
import { clientNameByPhone } from "@/lib/booking/reserve-ports";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Per-IP limit first — before any parsing or work (code guessing from one source).
  const limited = await hitRateLimit(serviceClient(), RATE_LIMITS.verifyCode, clientIpFrom(request.headers));
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSec);

  let phoneRaw: unknown;
  let codeRaw: unknown;
  try {
    const body = await request.json();
    phoneRaw = body?.phone;
    codeRaw = body?.code;
  } catch {
    return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 });
  }

  const phone = normalizePhoneIntl(typeof phoneRaw === "string" ? phoneRaw : "");
  const code = typeof codeRaw === "string" ? codeRaw.trim() : "";
  if (!phone || !/^\d{6}$/.test(code)) {
    // A malformed code returns the SAME 401 as a wrong code — no status oracle
    // that would tell an attacker their input shape was valid-but-wrong.
    return NextResponse.json({ error: "Código incorrecto." }, { status: 401 });
  }

  try {
    // The cookie client whose setSession writes the browser session cookies.
    const supabase = createClient();

    const ports = makePorts({
      nowMs: Date.now(),
      // establishSession mints the session server-side and hands the tokens
      // here; we write them into the response cookies via setSession.
      onSessionToken: async ({ accessToken, refreshToken }) => {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (error) throw new Error(`setSession: ${error.message}`);
      },
    });

    const res = await verifyCode(phone, code, ports);
    if (!res.ok) {
      // Single generic failure for every bad path (anti-oracle).
      return NextResponse.json({ error: "Código incorrecto." }, { status: 401 });
    }
    // Cookies were set by setSession inside onSessionToken; the middleware's
    // session refresh takes over from here.
    //
    // The phone is verified NOW, so telling its owner the name we have on file
    // is not an oracle — it lets the booking page greet a returning client
    // instead of asking her name again. A lookup failure must not fail the
    // verify: degrade to null.
    let name: string | null = null;
    try {
      name = await clientNameByPhone(serviceClient(), phone);
    } catch {
      name = null;
    }
    return NextResponse.json({ ok: true, name });
  } catch {
    return NextResponse.json({ error: "No se pudo verificar el código." }, { status: 500 });
  }
}

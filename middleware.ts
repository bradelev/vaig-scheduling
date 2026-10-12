import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { isStaffEmail } from "@/lib/auth/allowlist";
import { decideRoute, isPublicPath, isTransientAuthError, publicHostRedirect } from "@/lib/auth/route-decision";

/**
 * Session refresh + auth guard (PRD FR-4, issue E3-T1).
 * Everything except /login and /auth/* requires a session whose email is on
 * the STAFF_EMAILS allowlist. A session outside the allowlist is signed out
 * (defense in depth: the login action never sends magic links to outsiders,
 * but a session minted any other way must not get in either).
 *
 * Public booking host (PUBLIC_BOOKING_HOST, e.g. reservas.<domain>): the
 * client-facing hostname never shows the staff app — its root and any
 * non-booking path redirect to /reservar before anything else runs.
 */

function loginRedirect(request: NextRequest, error?: string): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = error ? `?error=${error}` : "";
  return NextResponse.redirect(url);
}

export async function middleware(request: NextRequest) {
  const bookingTarget = publicHostRedirect({
    host: request.headers.get("host"),
    pathname: request.nextUrl.pathname,
    publicHost: process.env.PUBLIC_BOOKING_HOST,
  });
  if (bookingTarget) {
    const to = request.nextUrl.clone();
    to.pathname = bookingTarget;
    to.search = "";
    return NextResponse.redirect(to);
  }

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Fail closed on misconfiguration, but keep the login page reachable so
    // the error is visible instead of a redirect loop.
    return isPublicPath(request.nextUrl.pathname)
      ? NextResponse.next({ request })
      : loginRedirect(request, "config");
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // getUser() validates the JWT against Supabase — never trust getSession()
  // alone in a guard. One retry on a TRANSIENT failure (network blip, 5xx):
  // without it, a healthy session bounced to /login and cost the team a full
  // email-OTP round trip (Cynthia, 2026-09-02). A definitive auth error
  // (revoked/invalid token, 4xx) is not retried — that session is gone.
  let userResult = await supabase.auth.getUser();
  if (userResult.error && isTransientAuthError(userResult.error)) {
    userResult = await supabase.auth.getUser();
  }
  const user = userResult.data.user;

  const decision = decideRoute({
    pathname: request.nextUrl.pathname,
    email: user?.email ?? null,
    isAllowed: isStaffEmail(user?.email),
  });

  if (decision === "redirect-login") return loginRedirect(request);
  if (decision === "deny") {
    await supabase.auth.signOut();
    const redirect = loginRedirect(request, "denied");
    // Carry over the cookie mutations signOut queued on `response`.
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  }
  return response;
}

export const config = {
  // Skip Next.js internals and static assets; everything else goes through
  // the guard.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|svg|ico)$).*)"],
};

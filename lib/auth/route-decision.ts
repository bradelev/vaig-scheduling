/**
 * Pure routing decision for the auth guard (issue E3-T1) — kept free of
 * Next.js APIs so the allowlist enforcement is unit-testable.
 */

export type RouteDecision =
  | "allow"
  | "redirect-login" // no session
  | "deny"; // session exists but the email is not on the allowlist

/**
 * Reachable without a (staff) session:
 *  - /login, /auth        : the staff login + magic-link endpoints
 *  - /api/client-auth     : the public client phone-login endpoints
 *                           (request-code / verify-code) — anon must reach them
 *                           to log in; they enforce their own rate-limit + OTP.
 *  - /reservar            : the public online-booking PAGE (own layout, no
 *                           staff shell). Its server actions only read the
 *                           catalog and free slots; the write is /api/reservar.
 *  - /api/reservar        : the public online-booking write. A phone-verified
 *                           CLIENT (synthetic-email JWT, NOT on the staff
 *                           allowlist) must reach it, so it can't be
 *                           allowlist-guarded — but the route itself requires a
 *                           client session (getUser → app_metadata.phone) and
 *                           401s anon. Listing it here only stops the guard from
 *                           signing the client OUT for not being staff.
 * NOTE: this only bypasses the staff-allowlist guard. It does NOT expose staff
 * pages to clients — a client's synthetic-email JWT is not on the allowlist, so
 * any non-public path still returns "deny" for them.
 */
const PUBLIC_PREFIXES = ["/login", "/auth", "/api/client-auth", "/api/reservar", "/reservar"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function decideRoute(input: {
  pathname: string;
  email: string | null;
  isAllowed: boolean;
}): RouteDecision {
  if (isPublicPath(input.pathname)) return "allow";
  if (!input.email) return "redirect-login";
  if (!input.isAllowed) return "deny";
  return "allow";
}

/** Paths the PUBLIC booking host serves; everything else there goes to /reservar. */
const PUBLIC_HOST_PREFIXES = ["/reservar", "/api/reservar", "/api/client-auth"];

/** Hostname only, lowercase — a Host header may carry a port ("host:3000"). */
export function normalizeHost(host: string | null | undefined): string {
  return (host ?? "").split(":")[0].trim().toLowerCase();
}

/**
 * The client-facing host (reservas.<domain>) must never show the staff app:
 * its root and any non-booking path redirect to /reservar. Returns the target
 * pathname, or null when no redirect applies (other hosts, or a booking path).
 * `publicHost` comes from PUBLIC_BOOKING_HOST; unset = feature off.
 */
export function publicHostRedirect(input: {
  host: string | null | undefined;
  pathname: string;
  publicHost: string | null | undefined;
}): string | null {
  const wanted = normalizeHost(input.publicHost);
  if (!wanted) return null;
  if (normalizeHost(input.host) !== wanted) return null;
  const onBookingPath = PUBLIC_HOST_PREFIXES.some(
    (prefix) => input.pathname === prefix || input.pathname.startsWith(`${prefix}/`),
  );
  return onBookingPath ? null : "/reservar";
}

/**
 * A getUser() failure worth ONE middleware retry: the fetch never got an
 * answer (network — auth-js AuthRetryableFetchError carries status 0, an
 * unparseable body carries undefined) or the auth server itself faltered
 * (5xx). A definitive 4xx rejection — revoked/invalid token, and notably
 * AuthSessionMissingError (400, the anonymous-request case) — must NOT be
 * retried: that answer is final, and retrying it would tax every
 * unauthenticated hit.
 */
export function isTransientAuthError(error: { status?: number }): boolean {
  return error.status === undefined || error.status === 0 || error.status >= 500;
}

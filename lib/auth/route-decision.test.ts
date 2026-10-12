import { describe, expect, it } from "vitest";
import { decideRoute, isPublicPath, normalizeHost, publicHostRedirect, isTransientAuthError } from "./route-decision";

describe("isPublicPath", () => {
  it("treats /login and /auth/* as public", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/auth")).toBe(true);
    expect(isPublicPath("/auth/confirm")).toBe(true);
  });

  it("treats the client-auth endpoints as public", () => {
    expect(isPublicPath("/api/client-auth")).toBe(true);
    expect(isPublicPath("/api/client-auth/request-code")).toBe(true);
    expect(isPublicPath("/api/client-auth/verify-code")).toBe(true);
  });

  it("treats the public-booking write as public (guard-bypass; route enforces client session)", () => {
    expect(isPublicPath("/api/reservar")).toBe(true);
  });

  it("treats the public-booking page as public (own layout, no staff shell)", () => {
    expect(isPublicPath("/reservar")).toBe(true);
    expect(isPublicPath("/reservar/")).toBe(true);
    expect(isPublicPath("/reservarx")).toBe(false); // lookalike
  });

  it("does not treat lookalike prefixes as public", () => {
    expect(isPublicPath("/loginx")).toBe(false);
    expect(isPublicPath("/authx/confirm")).toBe(false);
    expect(isPublicPath("/api/client-authx")).toBe(false); // lookalike
    expect(isPublicPath("/api/reservarx")).toBe(false); // lookalike
    expect(isPublicPath("/api/other")).toBe(false); // other api routes stay guarded
    expect(isPublicPath("/")).toBe(false);
  });
});

describe("decideRoute", () => {
  it("allows public paths without a session", () => {
    expect(
      decideRoute({ pathname: "/login", email: null, isAllowed: false }),
    ).toBe("allow");
    expect(
      decideRoute({ pathname: "/auth/confirm", email: null, isAllowed: false }),
    ).toBe("allow");
  });

  it("redirects to login when there is no session", () => {
    expect(decideRoute({ pathname: "/", email: null, isAllowed: false })).toBe(
      "redirect-login",
    );
  });

  it("denies a session whose email is outside the allowlist", () => {
    expect(
      decideRoute({
        pathname: "/",
        email: "outsider@example.com",
        isAllowed: false,
      }),
    ).toBe("deny");
  });

  it("allows a session whose email is on the allowlist", () => {
    expect(
      decideRoute({ pathname: "/", email: "ana@example.com", isAllowed: true }),
    ).toBe("allow");
  });
});

describe("publicHostRedirect — the client-facing host never shows the staff app", () => {
  const publicHost = "reservas.example.com";

  it("sends the root and any staff path on the public host to /reservar", () => {
    expect(publicHostRedirect({ host: publicHost, pathname: "/", publicHost })).toBe("/reservar");
    expect(publicHostRedirect({ host: publicHost, pathname: "/login", publicHost })).toBe("/reservar");
    expect(publicHostRedirect({ host: publicHost, pathname: "/clientas", publicHost })).toBe("/reservar");
    expect(publicHostRedirect({ host: publicHost, pathname: "/api/other", publicHost })).toBe("/reservar");
  });

  it("lets the booking paths through on the public host", () => {
    for (const p of ["/reservar", "/reservar/", "/api/reservar", "/api/client-auth/request-code"]) {
      expect(publicHostRedirect({ host: publicHost, pathname: p, publicHost })).toBeNull();
    }
    expect(publicHostRedirect({ host: publicHost, pathname: "/reservarx", publicHost })).toBe("/reservar"); // lookalike
  });

  it("does nothing on other hosts, with a port, or when the feature is unset", () => {
    expect(publicHostRedirect({ host: "app.example.com", pathname: "/", publicHost })).toBeNull();
    expect(publicHostRedirect({ host: "RESERVAS.example.com:3000", pathname: "/", publicHost })).toBe("/reservar");
    expect(publicHostRedirect({ host: publicHost, pathname: "/", publicHost: "" })).toBeNull();
    expect(publicHostRedirect({ host: publicHost, pathname: "/", publicHost: undefined })).toBeNull();
    expect(publicHostRedirect({ host: null, pathname: "/", publicHost })).toBeNull();
  });

  it("normalizeHost strips the port and case", () => {
    expect(normalizeHost("Reservas.Example.com:443")).toBe("reservas.example.com");
    expect(normalizeHost(null)).toBe("");
  });
});

describe("isTransientAuthError (the middleware's one-retry gate)", () => {
  it("retries network failures and auth-server faults", () => {
    expect(isTransientAuthError({ status: undefined })).toBe(true); // unparseable body
    expect(isTransientAuthError({ status: 0 })).toBe(true); // fetch never answered
    expect(isTransientAuthError({ status: 500 })).toBe(true);
    expect(isTransientAuthError({ status: 503 })).toBe(true);
  });

  it("never retries definitive rejections — incl. session-missing (400, every anonymous hit)", () => {
    expect(isTransientAuthError({ status: 400 })).toBe(false);
    expect(isTransientAuthError({ status: 401 })).toBe(false);
    expect(isTransientAuthError({ status: 403 })).toBe(false);
  });
});

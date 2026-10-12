import { beforeEach, describe, expect, it, vi } from "vitest";

// redirect() throws in Next; capture the destination instead of navigating.
class RedirectError extends Error {
  constructor(public to: string) {
    super(`REDIRECT:${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectError(to);
  },
}));

// Capture the auth calls; control their error return per test.
let otpArgs: unknown;
let verifyArgs: unknown;
let otpError: { message: string } | null;
let verifyError: { message: string } | null;

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      signInWithOtp: (a: unknown) => {
        otpArgs = a;
        return Promise.resolve({ error: otpError });
      },
      verifyOtp: (a: unknown) => {
        verifyArgs = a;
        return Promise.resolve({ error: verifyError });
      },
      signOut: () => Promise.resolve({ error: null }),
    },
  }),
}));
vi.mock("next/headers", () => ({
  cookies: () => ({ getAll: () => [], set: () => {} }),
  headers: () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));

// Rate limiter: allowed unless a test says otherwise; records the keys hit.
let limiterAllows: boolean;
let limiterThrows: boolean;
let limiterKeys: string[];
let serviceEnvMissing: boolean;
vi.mock("../supabase/service", () => ({
  serviceClient: () => {
    if (serviceEnvMissing) throw new Error("Supabase service env not set");
    return {};
  },
}));
vi.mock("../security/rate-limit", async (orig) => {
  const real = await orig<typeof import("../security/rate-limit")>();
  return {
    ...real,
    hitRateLimit: (_db: unknown, rule: { scope: string }, key: string) => {
      if (limiterThrows) throw new Error("limiter down");
      limiterKeys.push(`${rule.scope}:${key}`);
      return Promise.resolve(limiterAllows ? { allowed: true } : { allowed: false, retryAfterSec: 60 });
    },
  };
});

/** Run an action that redirect()s and return where it redirected to. */
async function catchRedirect(fn: () => Promise<void>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof RedirectError) return e.to;
    throw e;
  }
  throw new Error("expected a redirect, got none");
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  limiterAllows = true;
  limiterThrows = false;
  serviceEnvMissing = false;
  limiterKeys = [];
  otpArgs = undefined;
  verifyArgs = undefined;
  otpError = null;
  verifyError = null;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon";
  process.env.STAFF_EMAILS = "staff@vaig.uy";
});

describe("sendCode", () => {
  it("sends a code to a staff email and goes to the code step", async () => {
    const { sendCode } = await import("./actions");
    const to = await catchRedirect(() => sendCode(form({ email: "staff@vaig.uy" })));
    expect(otpArgs).toMatchObject({
      email: "staff@vaig.uy",
      options: { shouldCreateUser: true },
    });
    expect(to).toContain("step=code");
    expect(to).toContain("email=staff%40vaig.uy");
  });

  it("does NOT reveal non-staff: same code step, no email sent", async () => {
    const { sendCode } = await import("./actions");
    const to = await catchRedirect(() =>
      sendCode(form({ email: "outsider@nope.com" })),
    );
    expect(otpArgs).toBeUndefined(); // signInWithOtp never called
    expect(to).toContain("step=code"); // identical screen to the staff path
  });

  it("rejects an empty email", async () => {
    const { sendCode } = await import("./actions");
    const to = await catchRedirect(() => sendCode(form({ email: "  " })));
    expect(to).toBe("/login?error=invalid");
    expect(otpArgs).toBeUndefined();
  });

  it("surfaces a send error", async () => {
    otpError = { message: "smtp down" };
    const { sendCode } = await import("./actions");
    const to = await catchRedirect(() => sendCode(form({ email: "staff@vaig.uy" })));
    expect(to).toBe("/login?error=send");
  });
});

describe("verifyCode", () => {
  it("verifies a valid code for a staff email and enters the app", async () => {
    const { verifyCode } = await import("./actions");
    const to = await catchRedirect(() =>
      verifyCode(form({ email: "staff@vaig.uy", token: "123456" })),
    );
    expect(verifyArgs).toEqual({
      email: "staff@vaig.uy",
      token: "123456",
      type: "email",
    });
    expect(to).toBe("/");
  });

  it("rejects a wrong/expired code back to the code step", async () => {
    verifyError = { message: "invalid otp" };
    const { verifyCode } = await import("./actions");
    const to = await catchRedirect(() =>
      verifyCode(form({ email: "staff@vaig.uy", token: "000000" })),
    );
    expect(to).toContain("step=code");
    expect(to).toContain("error=code");
  });

  it("never mints a session for a non-staff email, even with a token", async () => {
    const { verifyCode } = await import("./actions");
    const to = await catchRedirect(() =>
      verifyCode(form({ email: "outsider@nope.com", token: "123456" })),
    );
    expect(verifyArgs).toBeUndefined(); // verifyOtp never called
    expect(to).toContain("error=code");
  });

  it("rejects a missing token", async () => {
    const { verifyCode } = await import("./actions");
    const to = await catchRedirect(() =>
      verifyCode(form({ email: "staff@vaig.uy", token: "" })),
    );
    expect(to).toContain("error=code");
    expect(verifyArgs).toBeUndefined();
  });
});

describe("staff login rate limiting", () => {
  it("counts code sends per IP and refuses when over the limit, without sending", async () => {
    limiterAllows = false;
    const { sendCode } = await import("./actions");
    const to = await catchRedirect(() => sendCode(form({ email: "staff@vaig.uy" })));
    expect(to).toBe("/login?error=rate");
    expect(otpArgs).toBeUndefined();
    expect(limiterKeys).toEqual(["staff-send-code:203.0.113.7"]);
  });

  it("gives outsiders the same rate-limit answer as staff (no enumeration)", async () => {
    limiterAllows = false;
    const { sendCode } = await import("./actions");
    const to = await catchRedirect(() => sendCode(form({ email: "outsider@nope.com" })));
    expect(to).toBe("/login?error=rate");
  });

  it("counts verifications per IP and per email, and refuses without verifying", async () => {
    limiterAllows = false;
    const { verifyCode } = await import("./actions");
    const to = await catchRedirect(() =>
      verifyCode(form({ email: "Staff@vaig.uy", token: "123456" })),
    );
    expect(to).toContain("step=code");
    expect(to).toContain("error=rate");
    expect(verifyArgs).toBeUndefined();
    expect(limiterKeys[0]).toBe("staff-verify-code:203.0.113.7");
  });

  it("checks the per-email counter with a normalized email", async () => {
    const { verifyCode } = await import("./actions");
    await catchRedirect(() => verifyCode(form({ email: "Staff@vaig.uy", token: "123456" })));
    expect(limiterKeys).toEqual([
      "staff-verify-code:203.0.113.7",
      "staff-verify-email:staff@vaig.uy",
    ]);
  });

  it("fails closed with a config error when the service env is missing", async () => {
    serviceEnvMissing = true;
    const { verifyCode } = await import("./actions");
    const to = await catchRedirect(() =>
      verifyCode(form({ email: "staff@vaig.uy", token: "123456" })),
    );
    expect(to).toContain("error=config");
    expect(verifyArgs).toBeUndefined();
  });

  it("fails closed when the limiter refuses (its own outage is a refusal)", async () => {
    limiterAllows = false;
    const { verifyCode } = await import("./actions");
    const to = await catchRedirect(() =>
      verifyCode(form({ email: "staff@vaig.uy", token: "123456" })),
    );
    expect(to).toContain("error=rate");
    expect(verifyArgs).toBeUndefined();
  });

  it("fails closed if the limiter call itself throws", async () => {
    limiterThrows = true;
    const { sendCode } = await import("./actions");
    const to = await catchRedirect(() => sendCode(form({ email: "staff@vaig.uy" })));
    expect(to).toBe("/login?error=rate");
    expect(otpArgs).toBeUndefined();
  });
});

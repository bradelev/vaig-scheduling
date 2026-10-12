// Security regression net for Server Actions. Next dispatches an action by id
// from any route the middleware lets through, and staff actions run with the
// service role — so every one of them must refuse a caller without a staff
// session BEFORE touching the database (see ./require-staff.ts).
//
// Two checks:
// 1. Inventory: every "use server" module under lib/ and app/ is classified
//    below. A new module fails this test until someone decides, explicitly,
//    whether it is staff-only or intentionally reachable without staff.
// 2. Behavior: with requireStaff refusing, every exported function of every
//    staff module returns/throws "No autorizado." and never creates a
//    service-role client.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = join(__dirname, "..", "..");

/** Staff-only modules: every export must call requireStaff first. */
const STAFF_MODULES = [
  "lib/booking/actions.ts",
  "lib/booking/date-map-actions.ts",
  "lib/booking/hours-actions.ts",
  "lib/catalog/actions.ts",
  "lib/clients/actions.ts",
  "lib/packages/actions.ts",
  "lib/recovery/actions.ts",
  "lib/reviews/actions.ts",
  "lib/sessions/actions.ts",
  "lib/staff/actions.ts",
  "lib/unmatched/actions.ts",
] as const;

/**
 * Modules that legitimately run without a staff session, with the reason.
 * None of them may use the service role on behalf of an unverified caller.
 */
const NON_STAFF_MODULES: Record<string, string> = {
  "lib/auth/actions.ts": "staff login itself (allowlist checked inside)",
  "lib/booking/public-actions.ts": "public booking week read, per-IP rate limited, catalog/slot data only",
  "lib/clients/pick.ts": "cookie-session client; RLS is_staff() gates the rows",
  "lib/unmatched/count.ts": "cookie-session client; RLS is_staff() gates the rows",
  "lib/reactivation/actions.ts": "cookie-session client; RLS is_staff() gates the rows",
  "lib/sessions/pending-count.ts": "cookie-session client; RLS is_staff() gates the rows",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

function serverActionModules(): string[] {
  return ["lib", "app"]
    .flatMap((d) => walk(join(ROOT, d)))
    .filter((p) => /^\s*["']use server["'];?/.test(readFileSync(p, "utf8")))
    .map((p) => relative(ROOT, p).split("\\").join("/"))
    .sort();
}

describe("server action inventory", () => {
  it("classifies every 'use server' module as staff-only or explicitly non-staff", () => {
    const known = new Set<string>([...STAFF_MODULES, ...Object.keys(NON_STAFF_MODULES)]);
    const unclassified = serverActionModules().filter((m) => !known.has(m));
    expect(unclassified).toEqual([]);
  });

  it("has no stale entries in the classification lists", () => {
    const present = new Set(serverActionModules());
    const stale = [...STAFF_MODULES, ...Object.keys(NON_STAFF_MODULES)].filter((m) => !present.has(m));
    expect(stale).toEqual([]);
  });
});

// ---- behavior: refused caller, no service-role client ----

// Records calls only; the assertion below is what fails a leaking action.
const serviceClient = vi.fn(() => ({}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("redirect");
  }),
}));
vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => undefined, getAll: () => [], set: vi.fn() }),
  headers: () => new Headers(),
}));
vi.mock("./require-staff", () => ({
  requireStaff: () => Promise.resolve({ error: "No autorizado." }),
}));
vi.mock("../supabase/service", () => ({ serviceClient: () => serviceClient() }));

const loaders: Record<(typeof STAFF_MODULES)[number], () => Promise<Record<string, unknown>>> = {
  "lib/booking/actions.ts": () => import("../booking/actions"),
  "lib/booking/date-map-actions.ts": () => import("../booking/date-map-actions"),
  "lib/booking/hours-actions.ts": () => import("../booking/hours-actions"),
  "lib/catalog/actions.ts": () => import("../catalog/actions"),
  "lib/clients/actions.ts": () => import("../clients/actions"),
  "lib/packages/actions.ts": () => import("../packages/actions"),
  "lib/recovery/actions.ts": () => import("../recovery/actions"),
  "lib/reviews/actions.ts": () => import("../reviews/actions"),
  "lib/sessions/actions.ts": () => import("../sessions/actions"),
  "lib/staff/actions.ts": () => import("../staff/actions"),
  "lib/unmatched/actions.ts": () => import("../unmatched/actions"),
};

/** A plausible-looking argument: a valid action would get past input checks. */
const SAMPLE_INPUT = new Proxy(
  {},
  {
    get: (_t, key) => {
      if (key === "then") return undefined;
      if (key === "durationMin" || key === "durationMinutes") return 60;
      if (key === "startsAt") return "2030-01-15T13:00:00.000Z";
      if (key === "aliasTokens") return ["ana"];
      return "00000000-0000-4000-8000-000000000001";
    },
  },
);

describe.each(STAFF_MODULES)("%s refuses a non-staff caller", (modulePath) => {
  beforeEach(() => serviceClient.mockClear());

  it("every export returns or throws 'No autorizado.' without a service-role client", async () => {
    const mod = await loaders[modulePath]();
    const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
    expect(fns.length).toBeGreaterThan(0);

    for (const [name, fn] of fns) {
      let outcome: unknown;
      try {
        outcome = await (fn as (arg: unknown) => Promise<unknown>)(SAMPLE_INPUT);
      } catch (err) {
        outcome = { thrown: err instanceof Error ? err.message : String(err) };
      }
      expect({ name, outcome }).toEqual({
        name,
        outcome: expect.objectContaining(
          (outcome as { thrown?: string })?.thrown !== undefined
            ? { thrown: "No autorizado." }
            : { error: "No autorizado." },
        ),
      });
    }
    expect(serviceClient).not.toHaveBeenCalled();
  });
});

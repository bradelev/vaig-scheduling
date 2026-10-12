/**
 * RLS integration tests for migration 0001_init (issue E1-T1, PRD §6).
 * CI-only: requires the runner's Supabase stack (`supabase start`).
 * Credentials come from `npx supabase status -o env` at runtime, per the
 * CLAUDE.md contract (default local URLs/keys).
 *
 * All personal data below is invented (CLAUDE.md sensitive-data rule).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";

const TEST_PHONE = "+59891234567";
const TEST_EMAIL = "staff-test@example.com";
const TEST_PASSWORD = "integration-test-password";
// A second authenticated user whose email is NOT in staff_emails — stands in
// for a future client JWT. Must be blocked from all PII by the new RLS.
const OUTSIDER_EMAIL = "outsider-test@example.com";
const OUTSIDER_PASSWORD = "integration-test-password-2";

let service: SupabaseClient;
let anon: SupabaseClient;
let staff: SupabaseClient;
let outsider: SupabaseClient;
let staffUserId: string;
let outsiderUserId: string;
let clientRowId: string;

beforeAll(async () => {
  const { url, anonKey, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);
  anon = createClient(url, anonKey, clientOptions);

  // Seed one row in EVERY table as service_role (bypasses RLS; needs table
  // grants) — the anon assertions below are only discriminating when a real
  // row exists to be blocked.
  const { data: seeded, error: seedError } = await service
    .from("clients")
    .insert({ full_name: "Test Client", phone: TEST_PHONE })
    .select("id")
    .single();
  if (seedError) throw new Error(`service_role seed failed: ${seedError.message}`);
  clientRowId = seeded.id;

  const seeds = [
    service.from("aliases").insert({
      client_id: clientRowId,
      raw_alias: "test client seed",
      alias_tokens: ["test", "client", "seed"],
      source: "seed",
    }),
    service.from("sessions").insert({
      gcal_event_id: "evt-rls-seed",
      client_id: clientRowId,
      starts_at: new Date("2026-08-01T14:00:00Z").toISOString(),
    }),
    service.from("job_runs").insert({ job: "sync-calendar", ok: true }),
  ];
  for (const seed of seeds) {
    const { error } = await seed;
    if (error) throw new Error(`service_role seed failed: ${error.message}`);
  }

  // The DB-side staff allowlist that is_staff() reads. Seed the staff test
  // email so the staff JWT is recognized (the regression guard: staff pages
  // rely on this). The outsider email is deliberately NOT added.
  const { error: allowlistError } = await service
    .from("staff_emails")
    .insert({ email: TEST_EMAIL });
  if (allowlistError) {
    throw new Error(`staff_emails seed failed: ${allowlistError.message}`);
  }

  // A confirmed staff user, signed in through the anon client flow.
  const { data: created, error: userError } = await service.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (userError) throw new Error(`createUser failed: ${userError.message}`);
  staffUserId = created.user.id;

  staff = createClient(url, anonKey, clientOptions);
  const { error: signInError } = await staff.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (signInError) throw new Error(`signIn failed: ${signInError.message}`);

  // A confirmed NON-staff authenticated user (email NOT in staff_emails).
  const { data: outsiderCreated, error: outsiderErr } =
    await service.auth.admin.createUser({
      email: OUTSIDER_EMAIL,
      password: OUTSIDER_PASSWORD,
      email_confirm: true,
    });
  if (outsiderErr) throw new Error(`createUser(outsider) failed: ${outsiderErr.message}`);
  outsiderUserId = outsiderCreated.user.id;

  outsider = createClient(url, anonKey, clientOptions);
  const { error: outsiderSignIn } = await outsider.auth.signInWithPassword({
    email: OUTSIDER_EMAIL,
    password: OUTSIDER_PASSWORD,
  });
  if (outsiderSignIn) throw new Error(`signIn(outsider) failed: ${outsiderSignIn.message}`);
});

afterAll(async () => {
  await service.from("sessions").delete().eq("gcal_event_id", "evt-rls-seed");
  await service.from("job_runs").delete().eq("job", "sync-calendar");
  // Deleting the client cascades the alias (on delete cascade).
  await service.from("clients").delete().eq("phone", TEST_PHONE);
  await service.from("staff_emails").delete().eq("email", TEST_EMAIL);
  if (staffUserId) await service.auth.admin.deleteUser(staffUserId);
  if (outsiderUserId) await service.auth.admin.deleteUser(outsiderUserId);
});

describe("anon reads nothing (PRD §6)", () => {
  for (const table of ["clients", "aliases", "sessions", "job_runs"]) {
    it(`cannot read ${table}`, async () => {
      const { data, error } = await anon.from(table).select("*");
      // Depending on grants the API answers "permission denied" or an empty
      // set. Every table was seeded with a real row in beforeAll, so the
      // empty branch proves RLS actually blocked something.
      if (error) {
        expect(error.message).toMatch(/permission denied|not exist/i);
      } else {
        expect(data).toEqual([]);
      }
    });
  }

  it("cannot insert into clients", async () => {
    const { error } = await anon
      .from("clients")
      .insert({ full_name: "Intruder", phone: "+59899999999" });
    expect(error).not.toBeNull();
  });
});

describe("authenticated staff has full access (PRD §6)", () => {
  it("reads the seeded client", async () => {
    const { data, error } = await staff
      .from("clients")
      .select("id, full_name, phone")
      .eq("phone", TEST_PHONE);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0].full_name).toBe("Test Client");
  });

  it("writes and deletes across tables", async () => {
    const { data: alias, error: insertError } = await staff
      .from("aliases")
      .insert({
        client_id: clientRowId,
        raw_alias: "test client",
        alias_tokens: ["test", "client"],
        source: "manual",
      })
      .select("id")
      .single();
    expect(insertError).toBeNull();

    const { error: updateError } = await staff
      .from("clients")
      .update({ notes: "updated by staff" })
      .eq("id", clientRowId);
    expect(updateError).toBeNull();

    const { error: deleteError } = await staff
      .from("aliases")
      .delete()
      .eq("id", alias!.id);
    expect(deleteError).toBeNull();
  });

  it("check constraints reject invalid enum values", async () => {
    const { error } = await staff.from("sessions").insert({
      gcal_event_id: "evt-invalid-status",
      starts_at: new Date("2026-08-01T14:00:00Z").toISOString(),
      status: "not-a-status",
    });
    expect(error).not.toBeNull();
  });
});

// The Phase-0 security property: an authenticated JWT whose email is NOT in
// staff_emails (i.e. a future client login) must NOT read client PII — this is
// the whole point of replacing `using(true)`. It stands in for the Phase 1
// client JWT before that identity exists.
describe("non-staff authenticated is blocked from PII (Phase 0)", () => {
  for (const table of ["clients", "aliases", "sessions", "job_runs"]) {
    it(`cannot read ${table}`, async () => {
      const { data, error } = await outsider.from(table).select("*");
      // is_staff() → false → RLS returns an empty set (grants still allow the
      // call, so it's not a permission error — it's zero rows).
      if (error) {
        expect(error.message).toMatch(/permission denied|not exist/i);
      } else {
        expect(data).toEqual([]);
      }
    });
  }

  it("cannot read the seeded client even by phone", async () => {
    const { data } = await outsider
      .from("clients")
      .select("id, full_name, phone")
      .eq("phone", TEST_PHONE);
    expect(data ?? []).toEqual([]);
  });

  it("cannot insert into clients", async () => {
    const { error } = await outsider
      .from("clients")
      .insert({ full_name: "Client JWT", phone: "+59899888777" });
    expect(error).not.toBeNull();
  });

  it("cannot read the staff_emails allowlist", async () => {
    const { data, error } = await outsider.from("staff_emails").select("*");
    // Not granted to authenticated at all → permission denied or empty.
    if (error) {
      expect(error.message).toMatch(/permission denied|not exist/i);
    } else {
      expect(data).toEqual([]);
    }
  });

  // Views are the exact surface the staff app reads AND the most plausible
  // accidental PII-leak vector (a security-DEFINER view would bypass the base
  // table's RLS). All views are security_invoker today, so the outsider must
  // get zero rows through them — this locks that property against regression.
  for (const view of ["v_client_status", "v_unmatched"]) {
    it(`cannot read PII through ${view}`, async () => {
      const { data, error } = await outsider.from(view).select("*");
      if (error) {
        expect(error.message).toMatch(/permission denied|not exist/i);
      } else {
        expect(data).toEqual([]);
      }
    });
  }
});

// The blast-radius regression guard: the staff cookie client reads these
// catalog/internal tables on the Nueva sesión / Horarios / agenda pages. With
// the new is_staff() predicate they must still be readable by staff.
describe("staff retains access to catalog tables (blast-radius guard)", () => {
  for (const table of ["staff", "service_types", "staff_hours", "booking_services", "staff_services"]) {
    it(`staff can read ${table}`, async () => {
      const { error } = await staff.from(table).select("*").limit(1);
      expect(error).toBeNull();
    });
  }

  it("the outsider cannot read the staff catalog", async () => {
    // staff table holds phone (PII) — a non-staff JWT must get nothing.
    const { data } = await outsider.from("staff").select("*");
    expect(data ?? []).toEqual([]);
  });

  // Staff must still read the views the app depends on (security_invoker →
  // enforced as the staff JWT, which now must pass is_staff()).
  for (const view of ["v_client_status", "v_unmatched"]) {
    it(`staff can read ${view}`, async () => {
      const { error } = await staff.from(view).select("*").limit(1);
      expect(error).toBeNull();
    });
  }
});

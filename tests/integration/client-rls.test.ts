/**
 * Client-owns-own RLS (Phase 1 slice 2, CI-only). Proves the security property
 * of the whole phone-login: a phone-verified client (synthetic-email user with
 * their phone in a top-level JWT claim, via the custom_access_token hook) reads
 * ONLY their own clients row and their own sessions — never another client's,
 * never the whole PII base. Staff still read everything; a phone client is not
 * staff.
 *
 * This is the make-or-break test: if client A can read client B's row, the
 * public booking surface leaks PII. All data invented (fixture E.164).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";

const A_PHONE = "+59891000001";
const B_PHONE = "+59891000002";
const A_EMAIL = "59891000001@clientes.vaig.internal";
const B_EMAIL = "59891000002@clientes.vaig.internal";
const PASSWORD = "integration-test-client-pw";

let service: SupabaseClient;
let clientA: SupabaseClient;
let aUserId: string;
let bUserId: string;
let aClientRowId: string;
let bClientRowId: string;

async function makeClientUser(
  service: SupabaseClient,
  email: string,
  phone: string,
): Promise<string> {
  const { data, error } = await service.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    // app_metadata (admin-only writable) — the client can't forge their phone.
    app_metadata: { phone },
  });
  if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
  return data.user.id;
}

beforeAll(async () => {
  const { url, anonKey, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);

  // Two real client rows + a session each, seeded as service_role.
  const seedA = await service
    .from("clients")
    .insert({ full_name: "Cliente A", phone: A_PHONE })
    .select("id")
    .single();
  if (seedA.error) throw new Error(`seed A failed: ${seedA.error.message}`);
  aClientRowId = seedA.data.id;

  const seedB = await service
    .from("clients")
    .insert({ full_name: "Cliente B", phone: B_PHONE })
    .select("id")
    .single();
  if (seedB.error) throw new Error(`seed B failed: ${seedB.error.message}`);
  bClientRowId = seedB.data.id;

  const sessA = await service.from("sessions").insert({
    gcal_event_id: "evt-crls-a",
    client_id: aClientRowId,
    starts_at: new Date("2026-09-04T14:00:00Z").toISOString(),
  });
  if (sessA.error) throw new Error(`seed session A failed: ${sessA.error.message}`);
  const sessB = await service.from("sessions").insert({
    gcal_event_id: "evt-crls-b",
    client_id: bClientRowId,
    starts_at: new Date("2026-09-04T15:00:00Z").toISOString(),
  });
  if (sessB.error) throw new Error(`seed session B failed: ${sessB.error.message}`);

  aUserId = await makeClientUser(service, A_EMAIL, A_PHONE);
  bUserId = await makeClientUser(service, B_EMAIL, B_PHONE);

  // Sign in as client A only (we test A's view of the world).
  clientA = createClient(url, anonKey, clientOptions);
  const signIn = await clientA.auth.signInWithPassword({ email: A_EMAIL, password: PASSWORD });
  if (signIn.error) throw new Error(`signIn A failed: ${signIn.error.message}`);
});

afterAll(async () => {
  await service.from("sessions").delete().like("gcal_event_id", "evt-crls-%");
  await service.from("clients").delete().in("phone", [A_PHONE, B_PHONE]);
  if (aUserId) await service.auth.admin.deleteUser(aUserId);
  if (bUserId) await service.auth.admin.deleteUser(bUserId);
});

describe("client A reads only their own data", () => {
  it("reads their OWN clients row", async () => {
    const { data, error } = await clientA
      .from("clients")
      .select("id, full_name, phone");
    expect(error).toBeNull();
    // Exactly one row — theirs.
    expect(data).toHaveLength(1);
    expect(data?.[0].phone).toBe(A_PHONE);
    expect(data?.[0].full_name).toBe("Cliente A");
  });

  it("CANNOT read client B's row (the PII-leak guard)", async () => {
    const { data } = await clientA
      .from("clients")
      .select("id, full_name, phone")
      .eq("phone", B_PHONE);
    expect(data ?? []).toEqual([]);
  });

  it("reads their OWN sessions only", async () => {
    const { data, error } = await clientA.from("sessions").select("id, client_id");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0].client_id).toBe(aClientRowId);
  });

  it("CANNOT read client B's session even by id", async () => {
    const { data } = await clientA
      .from("sessions")
      .select("id")
      .eq("client_id", bClientRowId);
    expect(data ?? []).toEqual([]);
  });

  it("CANNOT update even their OWN clients row (SELECT-only policy)", async () => {
    // A's own row IS visible to A (via client_owns_own SELECT), so this proves
    // the policy grants read but NOT write — there's no client UPDATE policy, so
    // the write matches zero rows (only is_staff() can write).
    const own = await clientA
      .from("clients")
      .update({ notes: "self-edit" })
      .eq("id", aClientRowId)
      .select("id");
    expect(own.data ?? []).toEqual([]);
    // Confirm at the DB (service role) that nothing changed.
    const check = await service.from("clients").select("notes").eq("id", aClientRowId).single();
    expect(check.data?.notes ?? null).toBeNull();
  });

  it("CANNOT update client B's row either", async () => {
    const upd = await clientA
      .from("clients")
      .update({ notes: "hacked" })
      .eq("id", bClientRowId)
      .select("id");
    // B's row isn't even visible → zero rows; B untouched.
    expect(upd.data ?? []).toEqual([]);
  });

  it("CANNOT read aliases (staff-only, no client policy)", async () => {
    const { data } = await clientA.from("aliases").select("*");
    expect(data ?? []).toEqual([]);
  });

  // The impersonation exploit the design defends against: the phone claim comes
  // from app_metadata (admin-only). A client trying to set user_metadata.phone
  // to B's phone must NOT gain B's data — because the hook reads app_metadata,
  // not user_metadata. This proves the choice of app_metadata closes the hole.
  it("CANNOT impersonate B by writing user_metadata.phone", async () => {
    // Client A writes their OWN user_metadata (allowed) trying to spoof B.
    const upd = await clientA.auth.updateUser({ data: { phone: B_PHONE } });
    expect(upd.error).toBeNull(); // the write itself is allowed...
    // ...but they must re-auth to get a new token; refresh the session.
    await clientA.auth.refreshSession();
    // The hook still reads app_metadata (A's real phone), so A sees only A —
    // NEVER B — even with user_metadata.phone spoofed to B.
    const { data } = await clientA.from("clients").select("phone").eq("phone", B_PHONE);
    expect(data ?? []).toEqual([]);
    const own = await clientA.from("clients").select("phone");
    expect(own.data).toHaveLength(1);
    expect(own.data?.[0].phone).toBe(A_PHONE);
  });
});

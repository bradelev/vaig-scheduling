/**
 * Cuponera ledger integration test (CI-only): the SQL side of migration
 * 20260830162934 — the atomic credit take (consume_package_credit), the
 * clamped ledger move (adjust_package_credit), the session link, and that the
 * functions are not callable as anon. Money-adjacent, so exercised against a
 * real Postgres, not reasoned about.
 *
 * All data invented (fixture E.164, invented item). Seeds as service_role.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";

const PHONE = "+59891667788";
const ITEM_NAME = "Cuponera de prueba x2";
const EVT = "evt-cuponera-";

let service: SupabaseClient;
let anon: SupabaseClient;
let clientId: string;
let itemId: string;

type CreditRow = { id: string; total_sessions: number; used_sessions: number };

async function consume(): Promise<CreditRow | null> {
  const { data, error } = await service.rpc("consume_package_credit", { p_client: clientId, p_service: itemId });
  if (error) throw new Error(`consume: ${error.message}`);
  const rows = (Array.isArray(data) ? data : [data]).filter(Boolean) as CreditRow[];
  return rows[0] ?? null;
}

async function adjust(packageId: string, delta: number): Promise<CreditRow> {
  const { data, error } = await service.rpc("adjust_package_credit", { p_package: packageId, p_delta: delta });
  if (error) throw new Error(`adjust: ${error.message}`);
  return (Array.isArray(data) ? data : [data])[0] as CreditRow;
}

beforeAll(async () => {
  const { url, anonKey, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);
  anon = createClient(url, anonKey, clientOptions);
  const client = await service.from("clients").insert({ full_name: "Cuponera Probe", phone: PHONE }).select("id").single();
  if (client.error) throw new Error(`client seed: ${client.error.message}`);
  clientId = client.data.id;
  const item = await service
    .from("booking_services")
    .insert({ name: ITEM_NAME, category: "Cuponeras de Depilación Láser", duration_min: 30, package_sessions: 2, active: true })
    .select("id")
    .single();
  if (item.error) throw new Error(`item seed: ${item.error.message}`);
  itemId = item.data.id;
});

afterAll(async () => {
  await service.from("sessions").delete().like("gcal_event_id", `${EVT}%`);
  await service.from("client_packages").delete().eq("client_id", clientId);
  await service.from("booking_services").delete().eq("id", itemId);
  await service.from("clients").delete().eq("phone", PHONE);
});

describe("client_packages ledger", () => {
  it("consume takes credits until the package is exhausted, then yields nothing", async () => {
    expect(await consume()).toBeNull(); // no package yet

    const pkg = await service
      .from("client_packages")
      .insert({ client_id: clientId, booking_service_id: itemId, total_sessions: 2, used_sessions: 0 })
      .select("id")
      .single();
    if (pkg.error) throw new Error(pkg.error.message);

    expect(await consume()).toMatchObject({ id: pkg.data.id, total_sessions: 2, used_sessions: 1 });
    expect(await consume()).toMatchObject({ id: pkg.data.id, used_sessions: 2 });
    expect(await consume()).toBeNull(); // exhausted

    // Clamped ledger moves: give one back, over-refund clamps at 0, over-take clamps at total.
    expect(await adjust(pkg.data.id, -1)).toMatchObject({ used_sessions: 1 });
    expect(await adjust(pkg.data.id, -5)).toMatchObject({ used_sessions: 0 });
    expect(await adjust(pkg.data.id, 9)).toMatchObject({ used_sessions: 2 });

    // A cancelled package is never drawn from.
    await service.from("client_packages").update({ status: "cancelada", used_sessions: 0 }).eq("id", pkg.data.id);
    expect(await consume()).toBeNull();
    await service.from("client_packages").delete().eq("id", pkg.data.id);
  });

  it("concurrent takes with ONE credit left: exactly one wins", async () => {
    const pkg = await service
      .from("client_packages")
      .insert({ client_id: clientId, booking_service_id: itemId, total_sessions: 2, used_sessions: 1 })
      .select("id")
      .single();
    if (pkg.error) throw new Error(pkg.error.message);

    const results = await Promise.all([consume(), consume(), consume()]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const after = await service.from("client_packages").select("used_sessions").eq("id", pkg.data.id).single();
    expect(after.data?.used_sessions).toBe(2);
    await service.from("client_packages").delete().eq("id", pkg.data.id);
  });

  it("concurrent takes with credit LEFT all succeed (the lock waits, never skips)", async () => {
    // With SKIP LOCKED a blocked caller would skip the package and report "no
    // credit" (→ a phantom second purchase). With FOR UPDATE it waits and
    // re-reads, so 3 overlapping takes on 3 credits all land.
    const pkg = await service
      .from("client_packages")
      .insert({ client_id: clientId, booking_service_id: itemId, total_sessions: 3, used_sessions: 0 })
      .select("id")
      .single();
    if (pkg.error) throw new Error(pkg.error.message);

    const results = await Promise.all([consume(), consume(), consume()]);
    expect(results.filter((r) => r !== null)).toHaveLength(3);
    const after = await service.from("client_packages").select("used_sessions").eq("id", pkg.data.id).single();
    expect(after.data?.used_sessions).toBe(3);
    await service.from("client_packages").delete().eq("id", pkg.data.id);
  });

  it("a session links to its package; deleting the package unlinks (set null)", async () => {
    const pkg = await service
      .from("client_packages")
      .insert({ client_id: clientId, booking_service_id: itemId, total_sessions: 2, used_sessions: 1 })
      .select("id")
      .single();
    if (pkg.error) throw new Error(pkg.error.message);
    const sess = await service
      .from("sessions")
      .insert({
        gcal_event_id: `${EVT}link`,
        client_id: clientId,
        source: "app",
        starts_at: "2026-09-15T14:00:00Z",
        ends_at: "2026-09-15T14:30:00Z",
        status: "scheduled",
        booking_service_id: itemId,
        package_id: pkg.data.id,
        pending_confirmation: true,
      })
      .select("id, package_id")
      .single();
    if (sess.error) throw new Error(sess.error.message);
    expect(sess.data.package_id).toBe(pkg.data.id);

    await service.from("client_packages").delete().eq("id", pkg.data.id);
    const again = await service.from("sessions").select("package_id").eq("id", sess.data.id).single();
    expect(again.data?.package_id).toBeNull();
  });

  it("the ledger functions are not callable as anon", async () => {
    // 42501 = insufficient_privilege: the revoke is what stops anon — not a
    // schema-cache miss or a bad argument.
    const a = await anon.rpc("consume_package_credit", { p_client: clientId, p_service: itemId });
    expect(a.error?.code).toBe("42501");
    const b = await anon.rpc("adjust_package_credit", { p_package: clientId, p_delta: 1 });
    expect(b.error?.code).toBe("42501");
  });
});

/**
 * Migration package_credit_integrity: the atomic consume-or-create
 * (take_package_credit, advisory-locked) and the cancel-refund trigger
 * (sessions_refund_package_credit). Own client per describe — the ledger
 * tests above leave packages behind for the shared client.
 */
describe("package_credit_integrity", () => {
  const PHONE2 = "+59891667799";
  const EVT2 = "evt-integrity-";
  let clientId2: string;

  type TakeRow = CreditRow & { created: boolean };
  async function take(client: string, total = 2): Promise<TakeRow> {
    const { data, error } = await service.rpc("take_package_credit", {
      p_client: client,
      p_service: itemId,
      p_total: total,
    });
    if (error) throw new Error(`take: ${error.message}`);
    return (Array.isArray(data) ? data : [data])[0] as TakeRow;
  }

  /** A distinct FUTURE 30-min window per offset (trigger refunds future only). */
  function futureWindow(offsetHours: number): { startsAt: string; endsAt: string } {
    const start = new Date(Date.now() + 10 * 86_400_000 + offsetHours * 3_600_000);
    return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 30 * 60_000).toISOString() };
  }

  async function seedPackageAndSession(
    evt: string,
    window: { startsAt: string; endsAt: string },
  ): Promise<{ packageId: string; sessionId: string }> {
    const pkg = await service
      .from("client_packages")
      .insert({ client_id: clientId2, booking_service_id: itemId, total_sessions: 2, used_sessions: 1 })
      .select("id")
      .single();
    if (pkg.error) throw new Error(pkg.error.message);
    const sess = await service
      .from("sessions")
      .insert({
        gcal_event_id: evt,
        client_id: clientId2,
        source: "app",
        starts_at: window.startsAt,
        ends_at: window.endsAt,
        status: "scheduled",
        booking_service_id: itemId,
        package_id: pkg.data.id,
        pending_confirmation: true,
      })
      .select("id")
      .single();
    if (sess.error) throw new Error(sess.error.message);
    return { packageId: pkg.data.id, sessionId: sess.data.id };
  }

  async function usedOf(packageId: string): Promise<number> {
    const res = await service.from("client_packages").select("used_sessions").eq("id", packageId).single();
    if (res.error) throw new Error(res.error.message);
    return res.data.used_sessions as number;
  }

  beforeAll(async () => {
    const client = await service.from("clients").insert({ full_name: "Integrity Probe", phone: PHONE2 }).select("id").single();
    if (client.error) throw new Error(`client2 seed: ${client.error.message}`);
    clientId2 = client.data.id;
  });

  afterAll(async () => {
    await service.from("sessions").delete().like("gcal_event_id", `${EVT2}%`);
    await service.from("client_packages").delete().eq("client_id", clientId2);
    await service.from("clients").delete().eq("phone", PHONE2);
  });

  it("take: creates on first use, consumes afterwards, creates again once exhausted", async () => {
    const first = await take(clientId2);
    expect(first.created).toBe(true);
    expect(first.used_sessions).toBe(1);
    const second = await take(clientId2);
    expect(second).toMatchObject({ id: first.id, created: false, used_sessions: 2 });
    // Exhausted (2/2): the next take is a NEW purchase, not a dead end.
    const third = await take(clientId2);
    expect(third.created).toBe(true);
    expect(third.id).not.toBe(first.id);
    // Clean the packages this test created so later tests start empty.
    await service.from("client_packages").delete().eq("client_id", clientId2);
  });

  it("simultaneous first purchases end with exactly ONE package (any interleaving)", async () => {
    const results = await Promise.all([take(clientId2, 3), take(clientId2, 3), take(clientId2, 3)]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.map((r) => r.used_sessions).sort()).toEqual([1, 2, 3]);
    await service.from("client_packages").delete().eq("client_id", clientId2);
  });

  it("cancelling a FUTURE session refunds its credit exactly once (any path)", async () => {
    const { packageId, sessionId } = await seedPackageAndSession(`${EVT2}future`, futureWindow(0));
    // The cancel is a bare status update — the same write sync-calendar makes.
    const upd = await service.from("sessions").update({ status: "cancelled" }).eq("id", sessionId);
    expect(upd.error).toBeNull();
    expect(await usedOf(packageId)).toBe(0);
    // Re-writing 'cancelled' is not a transition: no second refund.
    await service.from("sessions").update({ status: "cancelled" }).eq("id", sessionId);
    expect(await usedOf(packageId)).toBe(0);
  });

  it("a PAST session keeps its credit spent on cancel (no refund on cleanup)", async () => {
    const start = new Date(Date.now() - 3 * 86_400_000);
    const { packageId, sessionId } = await seedPackageAndSession(`${EVT2}past`, {
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    });
    await service.from("sessions").update({ status: "cancelled" }).eq("id", sessionId);
    expect(await usedOf(packageId)).toBe(1);
  });

  it("take_package_credit is not callable as anon", async () => {
    const res = await anon.rpc("take_package_credit", { p_client: clientId2, p_service: itemId, p_total: 2 });
    expect(res.error?.code).toBe("42501");
  });
});

/**
 * View integration tests for migration 0002_views (issue E1-T2, PRD §6).
 * CI-only: requires the runner's Supabase stack (`supabase start`).
 *
 * Every query filters on this file's own seed rows (phones / gcal_event_ids),
 * so it can run in parallel with the other integration files against the
 * same database. All personal data below is invented (CLAUDE.md rule).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";

const STAFF_EMAIL = "views-staff@example.com";
const STAFF_PASSWORD = "integration-test-password";

const PHONES = {
  reactivable: "+59891000001",
  withFuture: "+59891000002",
  optedOut: "+59891000003",
  onlyCancelled: "+59891000004",
  boundary21: "+59891000005",
  oldest: "+59891000006",
  noSessions: "+59891000007",
} as const;

const EVENT_PREFIX = "evt-views-";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

let service: SupabaseClient;
let anon: SupabaseClient;
let staff: SupabaseClient;
let staffUserId: string;
let nextSessionId: string;

beforeAll(async () => {
  const { url, anonKey, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);
  anon = createClient(url, anonKey, clientOptions);

  const { data: clients, error: clientsError } = await service
    .from("clients")
    .insert([
      { full_name: "Alba Reactivable", phone: PHONES.reactivable },
      { full_name: "Berta Con Futuro", phone: PHONES.withFuture },
      { full_name: "Carla Optout", phone: PHONES.optedOut, opted_out: true },
      { full_name: "Diana Cancelada", phone: PHONES.onlyCancelled },
      { full_name: "Elena Reciente", phone: PHONES.boundary21 },
      { full_name: "Flor Antigua", phone: PHONES.oldest },
      { full_name: "Hilda Sin Sesiones", phone: PHONES.noSessions },
    ],
    // In bulk inserts PostgREST fills the columns missing from a row with
    // explicit NULLs, overriding column defaults — opt into the defaults.
    { defaultToNull: false })
    .select("id, phone");
  if (clientsError) throw new Error(`client seed failed: ${clientsError.message}`);
  const idByPhone = Object.fromEntries(clients!.map((c) => [c.phone, c.id]));

  const { data: sessions, error: sessionsError } = await service
    .from("sessions")
    .insert([
      // Reactivable: one past session 30 days ago, nothing upcoming.
      {
        gcal_event_id: `${EVENT_PREFIX}a-past`,
        client_id: idByPhone[PHONES.reactivable],
        starts_at: daysAgo(30),
        service: "maderoterapia",
      },
      // With future: past 40 days ago + upcoming in 7 days.
      {
        gcal_event_id: `${EVENT_PREFIX}b-past`,
        client_id: idByPhone[PHONES.withFuture],
        starts_at: daysAgo(40),
        service: "presoterapia",
      },
      {
        gcal_event_id: `${EVENT_PREFIX}b-next`,
        client_id: idByPhone[PHONES.withFuture],
        starts_at: daysAhead(7),
        service: "radiofrecuencia",
      },
      // Opted out: reactivation-aged session, but opted_out = true.
      {
        gcal_event_id: `${EVENT_PREFIX}c-past`,
        client_id: idByPhone[PHONES.optedOut],
        starts_at: daysAgo(30),
      },
      // Only cancelled sessions, past and future: both laterals must skip them.
      {
        gcal_event_id: `${EVENT_PREFIX}d-past`,
        client_id: idByPhone[PHONES.onlyCancelled],
        starts_at: daysAgo(10),
        status: "cancelled",
      },
      {
        gcal_event_id: `${EVENT_PREFIX}d-next`,
        client_id: idByPhone[PHONES.onlyCancelled],
        starts_at: daysAhead(5),
        status: "cancelled",
      },
      // Boundary: exactly 21 days ago — not yet reactivable (> 21 required).
      {
        gcal_event_id: `${EVENT_PREFIX}e-past`,
        client_id: idByPhone[PHONES.boundary21],
        starts_at: daysAgo(21),
      },
      // Oldest reactivable: 60 days ago.
      {
        gcal_event_id: `${EVENT_PREFIX}f-past`,
        client_id: idByPhone[PHONES.oldest],
        starts_at: daysAgo(60),
      },
      // Unmatched (client_id null): future, past, and a cancelled one.
      {
        gcal_event_id: `${EVENT_PREFIX}u1`,
        starts_at: daysAhead(2),
        raw_title: "maria 15hs",
      },
      {
        gcal_event_id: `${EVENT_PREFIX}u2`,
        starts_at: daysAgo(1),
        raw_title: "lucia depilacion",
      },
      {
        gcal_event_id: `${EVENT_PREFIX}u3`,
        starts_at: daysAhead(3),
        raw_title: "cancelada 18hs",
        status: "cancelled",
      },
    ], { defaultToNull: false })
    .select("id, gcal_event_id");
  if (sessionsError) throw new Error(`session seed failed: ${sessionsError.message}`);
  nextSessionId = sessions!.find(
    (s) => s.gcal_event_id === `${EVENT_PREFIX}b-next`,
  )!.id;

  // RLS by role (migration 20260827204501): the staff cookie client only sees
  // rows when its email is in staff_emails. The views are security_invoker, so
  // they enforce that too — seed the allowlist or every staff read returns [].
  const { error: allowlistError } = await service
    .from("staff_emails")
    .insert({ email: STAFF_EMAIL });
  if (allowlistError) {
    throw new Error(`staff_emails seed failed: ${allowlistError.message}`);
  }

  const { data: created, error: userError } = await service.auth.admin.createUser({
    email: STAFF_EMAIL,
    password: STAFF_PASSWORD,
    email_confirm: true,
  });
  if (userError) throw new Error(`createUser failed: ${userError.message}`);
  staffUserId = created.user.id;

  staff = createClient(url, anonKey, clientOptions);
  const { error: signInError } = await staff.auth.signInWithPassword({
    email: STAFF_EMAIL,
    password: STAFF_PASSWORD,
  });
  if (signInError) throw new Error(`signIn failed: ${signInError.message}`);
});

afterAll(async () => {
  // Sessions first: sessions.client_id has no on-delete cascade.
  await service.from("sessions").delete().like("gcal_event_id", `${EVENT_PREFIX}%`);
  await service.from("clients").delete().in("phone", Object.values(PHONES));
  await service.from("staff_emails").delete().eq("email", STAFF_EMAIL);
  if (staffUserId) await service.auth.admin.deleteUser(staffUserId);
});

async function statusFor(phone: string) {
  const { data, error } = await staff
    .from("v_client_status")
    .select("*")
    .eq("phone", phone)
    .single();
  expect(error).toBeNull();
  return data!;
}

describe("v_client_status (PRD §6)", () => {
  it("computes last session and days_since_last, no next", async () => {
    const row = await statusFor(PHONES.reactivable);
    expect(row.last_service).toBe("maderoterapia");
    expect(row.days_since_last).toBe(30);
    expect(row.next_session_at).toBeNull();
    expect(row.next_session_id).toBeNull();
  });

  it("computes both last and next session", async () => {
    const row = await statusFor(PHONES.withFuture);
    expect(row.last_service).toBe("presoterapia");
    expect(row.days_since_last).toBe(40);
    expect(row.next_session_id).toBe(nextSessionId);
    expect(row.next_status).toBe("scheduled");
    expect(row.next_confirmed_at).toBeNull();
    expect(new Date(row.next_session_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("ignores cancelled sessions in both directions", async () => {
    const row = await statusFor(PHONES.onlyCancelled);
    expect(row.last_session_at).toBeNull();
    expect(row.last_service).toBeNull();
    expect(row.days_since_last).toBeNull();
    expect(row.next_session_at).toBeNull();
  });

  it("lists clients with no sessions at all, with null status", async () => {
    const row = await statusFor(PHONES.noSessions);
    expect(row.full_name).toBe("Hilda Sin Sesiones");
    expect(row.last_session_at).toBeNull();
    expect(row.next_session_at).toBeNull();
    expect(row.days_since_last).toBeNull();
  });
});

describe("v_unmatched (PRD §6)", () => {
  it("returns unmatched non-cancelled sessions, newest first", async () => {
    const { data, error } = await staff
      .from("v_unmatched")
      .select("gcal_event_id, raw_title")
      .like("gcal_event_id", `${EVENT_PREFIX}%`);
    expect(error).toBeNull();
    // The cancelled unmatched session (u3) must not appear.
    expect(data!.map((r) => r.raw_title)).toEqual(["maria 15hs", "lucia depilacion"]);
  });

  it("excludes matched sessions", async () => {
    const { data, error } = await staff
      .from("v_unmatched")
      .select("gcal_event_id")
      .eq("gcal_event_id", `${EVENT_PREFIX}a-past`);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

describe("v_reactivation (PRD §6)", () => {
  it("returns only reactivable clients, most recent first", async () => {
    const { data, error } = await staff
      .from("v_reactivation")
      .select("phone, days_since_last")
      .in("phone", Object.values(PHONES));
    expect(error).toBeNull();
    // In: > 21 days since last session, no next, not opted out.
    // Out: has a next session (B), opted out (C), only-cancelled (D),
    // exactly 21 days (E), no sessions at all (H).
    expect(data!.map((r) => r.phone)).toEqual([PHONES.reactivable, PHONES.oldest]);
    expect(data!.map((r) => r.days_since_last)).toEqual([30, 60]);
  });
});

describe("view grants (PRD §6: anon reads nothing)", () => {
  for (
    const view of [
      "v_client_status",
      "v_unmatched",
      "v_reactivation",
      "v_rebooking_past",
    ]
  ) {
    it(`anon cannot read ${view}`, async () => {
      const { data, error } = await anon.from(view).select("*");
      // Same discriminating pattern as rls.test.ts: the tables above are
      // seeded, so an empty result proves the view blocked something.
      if (error) {
        expect(error.message).toMatch(/permission denied|not exist/i);
      } else {
        expect(data).toEqual([]);
      }
    });
  }
});

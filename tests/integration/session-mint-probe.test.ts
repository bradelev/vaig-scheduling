/**
 * Session-mint probe (Phase 1 slice 3, CI-only): validate that we can turn a
 * verified phone into a usable browser session for the synthetic-email client
 * user WITHOUT a password — the delicate step in lib/client-auth/ports.ts
 * `establishSession`. The approach: admin.generateLink({type:'magiclink'}) →
 * verifyOtp({token_hash}) → a session with a working access/refresh token.
 *
 * Also confirms the minted JWT carries the top-level `phone` claim (the hook
 * from slice 2 runs on this issuance path too), so the whole chain — verify →
 * session → RLS-scoped read — works end to end.
 *
 * All data invented (fixture E.164). Runs against the runner's stack.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientOptions, localStackConfig } from "./helpers";
import { syntheticEmail } from "../../lib/client-auth/ports";

const PHONE = "+59891445566";

let service: SupabaseClient;
let userId: string;
let clientRowId: string;
let minted: { accessToken: string; refreshToken: string } | null = null;

beforeAll(async () => {
  const { url, serviceKey } = localStackConfig();
  service = createClient(url, serviceKey, clientOptions);

  // A real client row for this phone, so the RLS-scoped read has something.
  const seed = await service
    .from("clients")
    .insert({ full_name: "Mint Probe", phone: PHONE })
    .select("id")
    .single();
  if (seed.error) throw new Error(`seed failed: ${seed.error.message}`);
  clientRowId = seed.data.id;

  // Create the synthetic-email user with the phone in app_metadata.
  const email = syntheticEmail(PHONE);
  const created = await service.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { phone: PHONE },
  });
  if (created.error) throw new Error(`createUser failed: ${created.error.message}`);
  userId = created.data.user.id;

  // Mint a session the way establishSession does: generateLink → verifyOtp.
  const link = await service.auth.admin.generateLink({ type: "magiclink", email });
  if (link.error || !link.data.properties?.hashed_token) {
    throw new Error(`generateLink failed: ${link.error?.message ?? "no token"}`);
  }
  const verified = await service.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.data.properties.hashed_token,
  });
  if (verified.error || !verified.data.session) {
    throw new Error(`verifyOtp failed: ${verified.error?.message ?? "no session"}`);
  }
  minted = {
    accessToken: verified.data.session.access_token,
    refreshToken: verified.data.session.refresh_token,
  };
});

afterAll(async () => {
  await service.from("clients").delete().eq("phone", PHONE);
  if (userId) await service.auth.admin.deleteUser(userId);
});

describe("session mint (generateLink → verifyOtp)", () => {
  it("produces access + refresh tokens", () => {
    expect(minted?.accessToken).toBeTruthy();
    expect(minted?.refreshToken).toBeTruthy();
  });

  it("the minted JWT carries the top-level phone claim (hook ran)", () => {
    const claims = decodeJwt(minted!.accessToken);
    expect(claims.phone).toBe(PHONE);
  });

  it("a client using the minted session reads only their own row (end-to-end)", async () => {
    const { url, anonKey } = localStackConfig();
    const asClient = createClient(url, anonKey, clientOptions);
    const set = await asClient.auth.setSession({
      access_token: minted!.accessToken,
      refresh_token: minted!.refreshToken,
    });
    expect(set.error).toBeNull();

    const { data, error } = await asClient.from("clients").select("id, phone");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0].id).toBe(clientRowId);
    expect(data?.[0].phone).toBe(PHONE);
  });
});

function decodeJwt(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  const json = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(json);
}

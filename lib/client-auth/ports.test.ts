// Invented data only.
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findOrCreateClientUser, syntheticEmail } from "./ports";

const PHONE = "+59891234567";
const EMAIL = syntheticEmail(PHONE);

type FakeUser = { id: string; app_metadata: Record<string, unknown> };

/** A minimal auth admin fake: one user per email, ids from a counter. */
function fakeDb(existing?: FakeUser) {
  const users = new Map<string, FakeUser>();
  if (existing) users.set(EMAIL, existing);
  let next = 1;
  const admin = {
    createUser: vi.fn(async (input: { email: string; app_metadata: Record<string, unknown> }) => {
      if (users.has(input.email)) return { data: { user: null }, error: { message: "already registered" } };
      const user = { id: `new-${next++}`, app_metadata: input.app_metadata };
      users.set(input.email, user);
      return { data: { user }, error: null };
    }),
    getUserById: vi.fn(async (id: string) => {
      const user = Array.from(users.values()).find((u) => u.id === id) ?? null;
      return { data: { user }, error: user ? null : { message: "not found" } };
    }),
    deleteUser: vi.fn(async (id: string) => {
      users.forEach((u, email) => {
        if (u.id === id) users.delete(email);
      });
      return { data: {}, error: null };
    }),
  };
  const rpc = vi.fn(async (_fn: string, args: { p_email: string }) => ({
    data: users.get(args.p_email)?.id ?? null,
    error: null,
  }));
  return { db: { auth: { admin }, rpc } as unknown as SupabaseClient, admin, users };
}

describe("findOrCreateClientUser", () => {
  it("creates a new user with the phone in app_metadata", async () => {
    const { db, users } = fakeDb();
    const id = await findOrCreateClientUser(db, EMAIL, PHONE);
    expect(id).toBe("new-1");
    expect(users.get(EMAIL)?.app_metadata).toEqual({ phone: PHONE });
  });

  it("adopts a returning client whose user carries the service-set phone claim", async () => {
    const { db, admin } = fakeDb({ id: "old-1", app_metadata: { phone: PHONE } });
    expect(await findOrCreateClientUser(db, EMAIL, PHONE)).toBe("old-1");
    expect(admin.deleteUser).not.toHaveBeenCalled();
  });

  it("replaces a squatter that pre-registered the synthetic email via sign-up", async () => {
    // A self-signed-up user has only GoTrue's own app_metadata, never a phone.
    const { db, admin, users } = fakeDb({
      id: "attacker-1",
      app_metadata: { provider: "email", providers: ["email"] },
    });
    const id = await findOrCreateClientUser(db, EMAIL, PHONE);
    expect(admin.deleteUser).toHaveBeenCalledWith("attacker-1");
    expect(id).not.toBe("attacker-1");
    expect(users.get(EMAIL)).toEqual({ id, app_metadata: { phone: PHONE } });
  });

  it("replaces a user whose phone claim belongs to someone else", async () => {
    const { db, admin } = fakeDb({ id: "other-1", app_metadata: { phone: "+59899999999" } });
    const id = await findOrCreateClientUser(db, EMAIL, PHONE);
    expect(admin.deleteUser).toHaveBeenCalledWith("other-1");
    expect(id).not.toBe("other-1");
  });
});

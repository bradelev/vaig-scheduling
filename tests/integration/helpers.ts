// Shared plumbing for the CI-only integration tests (see rls.test.ts for context).

import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

function localStackConfig(): { url: string; anonKey: string; serviceKey: string } {
  const out = execSync("npx supabase status -o env", { encoding: "utf8" });
  const get = (names: string[]): string => {
    for (const name of names) {
      const m = out.match(new RegExp(`^${name}="?([^"\\n]+)"?$`, "m"));
      if (m) return m[1];
    }
    throw new Error(
      `None of [${names.join(", ")}] found in \`supabase status -o env\` output`,
    );
  };
  return {
    url: get(["API_URL", "SUPABASE_URL"]),
    anonKey: get(["ANON_KEY", "SUPABASE_ANON_KEY"]),
    serviceKey: get(["SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]),
  };
}

/**
 * supabase-js eagerly builds its realtime client, which requires a native
 * WebSocket that Node 20 (the CI runtime) doesn't ship. These tests never
 * touch realtime, so a never-instantiated stub transport satisfies the
 * constructor (realtime-js uses `options.transport ?? factory()`).
 */
class WebSocketStub {
  constructor() {
    throw new Error("realtime is not available in integration tests");
  }
}

type RealtimeTransport = NonNullable<
  NonNullable<Parameters<typeof createClient>[2]>["realtime"]
>["transport"];

export const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocketStub as unknown as RealtimeTransport },
};

export { localStackConfig, WebSocketStub };

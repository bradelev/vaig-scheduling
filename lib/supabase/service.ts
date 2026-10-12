import { createClient } from "@supabase/supabase-js";

/**
 * The service-role Supabase client for Server Actions that mutate as the
 * service role (the browser never sees the key). One definition — it was
 * copied byte-for-byte across lib/sessions, lib/unmatched and lib/clients.
 * The anon/staff client lives separately in lib/supabase/server.ts.
 */
export function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service env not set");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

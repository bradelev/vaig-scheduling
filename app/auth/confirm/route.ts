import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient, hasSupabaseEnv } from "@/lib/supabase/server";

/**
 * Magic-link landing endpoint (issue E3-T1). Supports both link shapes
 * Supabase can emit:
 *  - token_hash + type (the server-side flow — works across browsers)
 *  - code (PKCE — only completes in the browser that requested the link)
 * On success the session cookie is set and the middleware's allowlist guard
 * takes over; on failure the user lands back on /login with a readable error.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const loginWithError = NextResponse.redirect(
    new URL("/login?error=link", origin),
  );
  if (!hasSupabaseEnv()) {
    return NextResponse.redirect(new URL("/login?error=config", origin));
  }

  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  const supabase = createClient();

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL("/", origin));
    return loginWithError;
  }
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/", origin));
  }
  return loginWithError;
}

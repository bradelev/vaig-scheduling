import { Suspense, type ReactNode } from "react";
import { Bricolage_Grotesque, Inter_Tight } from "next/font/google";
import { hasSupabaseEnv } from "@/lib/supabase/server";
import { getPendingCount } from "@/lib/sessions/pending-count";
import { ACCENT, ACCENT_DARK, INK, PAGE_BG } from "@/lib/ui/theme";
import { NewSessionLink } from "./_components/NewSessionLink";
import { NavBar } from "./NavBar";

export const dynamic = "force-dynamic";

// Brand typography (2026-09-02): the same faces as the public booking page —
// Bricolage Grotesque for the brand/headings, Inter Tight for everything else —
// so panel and public page read as one product.
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["700", "800"],
  variable: "--font-display",
  display: "swap",
});
const body = Inter_Tight({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
  display: "swap",
});

// Shell width (2026-08-20). Was 640 — too narrow for the data tables (Clientes,
// Reactivación, Reseñas, agenda), which clipped phones and dates on desktop.
// Widened for desktop; mobile is unaffected (the phone's physical width wins,
// and the 16px side padding keeps the margins). The two form screens
// (Nueva sesión, Editar) keep their own inner maxWidth: 520, so they don't
// stretch. Header and main share this so they stay aligned.
const SHELL_MAX_WIDTH = 1080;

/**
 * Fetches the badge counts and renders the real nav. Suspended so the shell
 * (header + tabs + the page skeleton) paints immediately instead of blocking
 * the first byte on these two queries — the badges pop in when ready.
 */
async function NavBarWithCounts() {
  const pendingCount = await getPendingCount();
  return <NavBar initialCounts={{ pending: pendingCount }} />;
}

export default function AppLayout({ children }: { children: ReactNode }) {
  if (!hasSupabaseEnv()) {
    return (
      <main style={{ padding: 24 }}>
        <p>La app no está configurada todavía.</p>
      </main>
    );
  }

  return (
    <div
      className={`${display.variable} ${body.variable}`}
      style={{
        fontFamily:
          "var(--font-body), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        background: PAGE_BG,
        minHeight: "100dvh",
        color: INK,
      }}
    >
      {/* Section titles across every screen pick up the brand face without
          touching each file — they all render as h2/h3 inside <main>. */}
      <style>{`
        main h2, main h3 {
          font-family: var(--font-display), sans-serif;
          letter-spacing: -0.01em;
        }
        main { padding-bottom: 48px; }
        .hdr-new {
          display: inline-flex;
          align-items: center;
          min-height: 44px;
          padding: 0 16px;
          border-radius: 999px;
          background: ${ACCENT};
          color: #fff;
          font-size: 15px;
          font-weight: 700;
          text-decoration: none;
          white-space: nowrap;
        }
        .hdr-new:hover { background: ${ACCENT_DARK}; }
      `}</style>
      <div
        style={{
          maxWidth: SHELL_MAX_WIDTH,
          margin: "0 auto",
          padding: "16px 16px 0",
        }}
      >
        {/* The header row: wordmark left, + Nueva sesión right. The action
            lives HERE (2026-09-02) because a floating button overlapped the
            lists' right-side row actions while scrolling, and the header's
            right side is free since sign-out moved to Ajustes. (No sign-out
            here on purpose: the team's External habit is "buttons =
            navigation" — a logout button in daily reach logged people out.) */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h1
            style={{
              fontSize: 24,
              margin: 0,
              fontFamily: "var(--font-display), sans-serif",
              letterSpacing: "-0.02em",
              color: INK,
            }}
          >
            VA<b style={{ color: ACCENT }}>IG</b>
          </h1>
          <NewSessionLink />
        </div>

        <Suspense fallback={<NavBar initialCounts={{ pending: null }} />}>
          <NavBarWithCounts />
        </Suspense>
      </div>

      <main style={{ maxWidth: SHELL_MAX_WIDTH, margin: "0 auto", padding: "0 16px" }}>
        {children}
      </main>
    </div>
  );
}

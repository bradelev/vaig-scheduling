"use client";

/**
 * App navigation with live queue counts: "Sin identificar" (issue #82) and
 * "Reservas web" (public reservations awaiting the team, Phase 2). The layout
 * server-renders the initial counts; every route change re-asks the server so
 * the badges reflect work done along the way.
 *
 * Two tiers (Braulio, 2026-08-31): the daily core — Próximas sesiones and
 * Reservas web — reads big on top (+ Nueva sesión lives in the header row,
 * where it can never overlap list content, 2026-09-02); everything
 * else (incl. rarely-used Reactivación) sits on a quieter second row. The
 * Sin identificar badge is deliberately NEUTRAL: it's a queue, not an alarm.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { getPendingCount } from "@/lib/sessions/pending-count";
import { ACCENT, ACCENT_DARK, BORDER_SOFT, INK, MUTED } from "@/lib/ui/theme";

export type NavCounts = { pending: number | null };

/** Which tab shows which count, and how the badge reads to a screen reader.
 *  (Sin identificar left the bar 2026-09-02 — its urgent slice lives in the
 *  Para hoy strip, the backlog behind Ajustes — so only one badge remains.) */
const BADGES: Record<string, { key: keyof NavCounts; color: string; label: (n: number) => string }> = {
  "/por-confirmar": {
    key: "pending",
    color: "#b8621b",
    label: (n) => `${n} reservas web por confirmar`,
  },
};

type NavItem = { href: string; label: string };

/** The daily core — always big, always first. */
const PRIMARY_ITEMS: NavItem[] = [
  { href: "/clientas", label: "Próximas sesiones" },
  { href: "/por-confirmar", label: "Reservas web" },
];

/** Everything else — visible but quiet. Sin identificar, Reactivación and
 *  Reseñas moved behind Ajustes (Braulio, 2026-09-02: barely used day to day;
 *  the panel-usage metric will confirm with data). */
const SECONDARY_ITEMS: NavItem[] = [
  { href: "/cuponeras", label: "Cuponeras" },
  { href: "/clientes", label: "Clientes" },
  { href: "/ajustes", label: "Ajustes" },
];

/** Routes that belong to the Ajustes section (its tab stays lit inside them). */
const AJUSTES_ROUTES = [
  "/ajustes",
  "/horarios",
  "/servicios",
  "/profesionales",
  "/metricas",
  "/sin-identificar",
  "/reactivacion",
  "/resenas",
];

export function NavBar({ initialCounts }: { initialCounts: NavCounts }) {
  const pathname = usePathname();
  const [counts, setCounts] = useState<NavCounts>(initialCounts);
  // The tab being navigated to (clicked but the route hasn't changed yet) —
  // drives the progress bar + dimmed tab so a slow page load never looks dead.
  const [navTarget, setNavTarget] = useState<string | null>(null);
  // The server just rendered the fresh count — skip the mount refetch and
  // only re-ask on actual route changes.
  const firstRender = useRef(true);

  useEffect(() => {
    setNavTarget(null); // the navigation landed
    // Panel-usage ping (docs/booking-analytics.md): which screen just opened.
    // Fire-and-forget; the endpoint drops anything but known screens.
    void fetch("/api/panel/uso", {
      method: "POST",
      headers: { "content-type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ route: pathname }),
    }).catch(() => {});
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    let cancelled = false;
    getPendingCount().then((pending) => {
      if (cancelled) return;
      setCounts((c) => ({ pending: pending ?? c.pending }));
    });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  function isActive(href: string): boolean {
    if (href === "/ajustes") {
      return AJUSTES_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
    }
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  function renderTab(item: NavItem) {
    const badge = BADGES[item.href];
    const count = badge ? counts[badge.key] : null;
    const showBadge = badge && count !== null && count > 0;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={isActive(item.href) ? "page" : undefined}
        // Arm only when the pathname will actually change (re-tapping the
        // exact current page would leave the bar spinning forever). Exact
        // compare, not isActive(): subroute → parent (/clientas/123 →
        // /clientas) is a real navigation and deserves the indicator.
        onClick={() => { if (pathname !== item.href) setNavTarget(item.href); }}
        style={navTarget === item.href ? { opacity: 0.55 } : undefined}
      >
        {item.label}
        {showBadge ? (
          <span
            aria-label={badge.label(count)}
            style={{
              background: badge.color,
              color: "#fff",
              borderRadius: 999,
              fontSize: 11.5,
              fontWeight: 700,
              lineHeight: "18px",
              minWidth: 18,
              padding: "0 5px",
              textAlign: "center",
            }}
          >
            {count}
          </span>
        ) : null}
      </Link>
    );
  }

  return (
    <nav className="nav-tabs" style={{ marginTop: 14, position: "relative" }}>
      {/* dangerouslySetInnerHTML, not a text child: <style> is a raw-text
          element, so SSR entity-escaping of the quotes in [aria-current="page"]
          caused a hydration mismatch that re-rendered the entire app
          client-side on every load (longstanding, surfaced 2026-09-02). */}
      <style dangerouslySetInnerHTML={{ __html: `
        .nav-tabs a {
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          /* 44px tap target (project rule) — padding alone gave ~35px. */
          min-height: 44px;
          padding: 0 13px;
          text-decoration: none;
          border-radius: 8px 8px 0 0;
          border-bottom: 2px solid transparent;
          margin-bottom: -1px;
        }
        .nav-tabs a:hover { color: ${INK}; background: #eee8dc; }
        .nav-tabs a[aria-current="page"] { color: ${ACCENT_DARK}; border-bottom-color: ${ACCENT}; }
        .nav-main, .nav-sub {
          display: flex;
          align-items: center;
          column-gap: 2px;
          /* One line, sideways scroll on narrow screens — wrapping made the
             bar a three-row jumble on phones (2026-09-02). */
          flex-wrap: nowrap;
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: none;
        }
        .nav-main::-webkit-scrollbar, .nav-sub::-webkit-scrollbar { display: none; }
        .nav-tabs a { white-space: nowrap; }
        .nav-main a { font-size: 16px; font-weight: 700; color: ${INK}; }
        .nav-sub { margin-top: 2px; border-bottom: 1px solid ${BORDER_SOFT}; }
        .nav-sub a { font-size: 13px; font-weight: 600; color: ${MUTED}; min-height: 40px; }
        .nav-progress {
          /* Overlays the sub-row's border line — absolutely positioned so
             appearing/disappearing never shifts the page below. */
          position: absolute;
          left: 0;
          right: 0;
          bottom: -1px;
          height: 2px;
          background: linear-gradient(90deg, transparent, ${ACCENT}, transparent);
          background-size: 40% 100%;
          background-repeat: no-repeat;
          animation: nav-slide 1.1s linear infinite;
        }
        @keyframes nav-slide {
          from { background-position: -60% 0; }
          to { background-position: 160% 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .nav-progress { animation: none; background: ${ACCENT}; opacity: 0.5; }
        }
      ` }} />
      <div className="nav-main">
        {PRIMARY_ITEMS.map(renderTab)}
      </div>
      <div className="nav-sub">{SECONDARY_ITEMS.map(renderTab)}</div>
      {navTarget ? <div className="nav-progress" role="status" aria-label="Cargando página" /> : null}
    </nav>
  );
}

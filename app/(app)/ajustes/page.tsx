/**
 * Ajustes hub: the setup screens plus the occasional tools, grouped behind one
 * nav tab so the daily bar stays minimal (2026-08-31 simplification; the
 * herramientas group joined 2026-09-02 — Sin identificar, Reactivación and
 * Reseñas see little daily use per Braulio; the panel-usage metric verifies).
 */
import Link from "next/link";
import { hasSupabaseEnv } from "@/lib/supabase/server";
import { getUnmatchedCount } from "@/lib/unmatched/count";
import { SignOutButton } from "../_components/SignOutButton";

export const dynamic = "force-dynamic";

type Card = { href: string; title: string; desc: string; badge?: number | null };

const CONFIG_CARDS: Card[] = [
  {
    href: "/horarios",
    title: "Horarios",
    desc: "Quién trabaja cada día y en qué horario; aperturas y bloqueos puntuales.",
  },
  {
    href: "/servicios",
    title: "Servicios",
    desc: "El catálogo que ven las clientas: nombres, precios, duraciones, cuponeras y qué está activo.",
  },
  {
    href: "/profesionales",
    title: "Profesionales",
    desc: "El equipo: quién da cada servicio, su color en el calendario y su WhatsApp de avisos.",
  },
  {
    href: "/metricas",
    title: "Métricas",
    desc: "Cómo se usa la página de reservas: el embudo, qué falta ofertar y las reservas a medio camino.",
  },
];

function CardLink({ card }: { card: Card }) {
  return (
    <Link
      href={card.href}
      style={{
        display: "block",
        padding: "18px 18px 16px",
        border: "1px solid #e7e2d8",
        borderRadius: 12,
        background: "#fff",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, fontWeight: 700, color: "#1c222b", marginBottom: 6 }}>
        {card.title} →
        {card.badge ? (
          <span
            style={{
              background: "#8a919c",
              color: "#fff",
              borderRadius: 999,
              fontSize: 11.5,
              fontWeight: 700,
              lineHeight: "18px",
              minWidth: 18,
              padding: "0 6px",
              textAlign: "center",
            }}
          >
            {card.badge}
          </span>
        ) : null}
      </span>
      <span style={{ display: "block", fontSize: 13.5, lineHeight: 1.45, color: "#5b6169" }}>{card.desc}</span>
    </Link>
  );
}

const GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
  gap: 12,
  marginBottom: 24,
};

export default async function AjustesPage() {
  const unmatched = hasSupabaseEnv() ? await getUnmatchedCount() : null;

  const toolCards: Card[] = [
    {
      href: "/sin-identificar",
      title: "Sin identificar",
      desc: "Sesiones del calendario sin clienta asociada. Las urgentes (mañana) también avisan en Próximas sesiones.",
      badge: unmatched,
    },
    {
      href: "/reactivacion",
      title: "Reactivación",
      desc: "Clientas que hace tiempo no vienen, con el mensaje pronto para reenganchar.",
    },
    {
      href: "/resenas",
      title: "Reseñas",
      desc: "Seguimiento del pedido automático de reseñas de Google.",
    },
  ];

  return (
    <section>
      <h2 style={{ fontSize: 20, margin: "18px 0 4px" }}>Ajustes</h2>
      <p style={{ color: "#5b6169", fontSize: 14, margin: "0 0 16px" }}>
        La configuración del negocio. Los cambios acá impactan la página de reservas y la agenda.
      </p>
      <div style={GRID}>
        {CONFIG_CARDS.map((c) => (
          <CardLink key={c.href} card={c} />
        ))}
      </div>

      <h3 style={{ fontSize: 16, margin: "0 0 8px" }}>Herramientas</h3>
      <p style={{ color: "#5b6169", fontSize: 13.5, margin: "0 0 12px" }}>
        Se usan de vez en cuando — viven acá para que el menú del día a día quede liviano.
      </p>
      <div style={GRID}>
        {toolCards.map((c) => (
          <CardLink key={c.href} card={c} />
        ))}
      </div>

      {/* Sign-out lives HERE, not the header: the daily screens carry no
          logout button at all (see the layout comment, 2026-09-02). */}
      <div style={{ borderTop: "1px solid #e7e2d8", paddingTop: 16 }}>
        <p style={{ color: "#5b6169", fontSize: 13.5, margin: "0 0 8px" }}>
          Cierra la sesión del equipo en este dispositivo. Para volver a entrar hace falta el código
          que llega al mail del local — no lo uses salvo que cambies de aparato.
        </p>
        <SignOutButton />
      </div>
    </section>
  );
}

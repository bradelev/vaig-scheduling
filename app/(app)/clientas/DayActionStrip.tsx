import Link from "next/link";
import { ACCENT, BORDER_SOFT, SURFACE } from "@/lib/ui/theme";

/**
 * The day's pending-work strip (issue #101): turns Clientas from a board you
 * read into a list you clear. Three actionable counts, each a link to the
 * view that resolves it; when all are zero, a calm "todo al día". Server-
 * rendered from counts the page already computed — no client JS, no keys.
 */
export type DayActions = {
  /** Clients who tapped Reagendar and are still unresolved. */
  reagendar: number;
  /** VAIG asked to confirm tomorrow's session, no answer yet. */
  sinConfirmar: number;
  /** Tomorrow's sessions the system couldn't identify (no reminder unless fixed). */
  sinIdentificar: number;
};

type Item = { n: number; label: (n: number) => string; href: string; tone: string };

export function DayActionStrip({ actions }: { actions: DayActions }) {
  const items: Item[] = [
    {
      n: actions.reagendar,
      label: (n) => `${n} ${n === 1 ? "reagendo" : "reagendos"} sin resolver`,
      href: "/clientas?filtro=reagendar",
      tone: ACCENT,
    },
    {
      n: actions.sinConfirmar,
      label: (n) => `${n} sin confirmar mañana`,
      href: "/clientas?filtro=manana",
      tone: "#7a5200",
    },
    {
      n: actions.sinIdentificar,
      label: (n) =>
        `${n} sin identificar para mañana`,
      href: "/sin-identificar",
      tone: "#a02525",
    },
  ];
  const active = items.filter((i) => i.n > 0);

  if (active.length === 0) {
    return (
      <div
        style={{
          border: "1px solid #cfe8d4",
          background: "#f2faf4",
          borderRadius: 12,
          padding: "10px 14px",
          fontSize: 13.5,
          color: "#1a7a1a",
          fontWeight: 600,
          marginBottom: 12,
        }}
      >
        ✓ Todo al día — nada pendiente para hoy.
      </div>
    );
  }

  return (
    <div
      style={{
        border: `1px solid ${BORDER_SOFT}`,
        background: SURFACE,
        borderRadius: 12,
        padding: "10px 14px",
        marginBottom: 12,
        display: "flex",
        // One line; sideways scroll instead of stacking chips on phones.
        flexWrap: "nowrap",
        overflowX: "auto",
        gap: 8,
        alignItems: "center",
      }}
    >
      <strong style={{ fontSize: 12.5, color: "#33302b", flexShrink: 0 }}>Para hoy</strong>
      {active.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            minHeight: 32,
            padding: "0 12px",
            borderRadius: 999,
            border: `1px solid ${i.tone}`,
            color: i.tone,
            background: "#fff",
            fontSize: 13,
            fontWeight: 600,
            textDecoration: "none",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {i.label(i.n)}
          <span aria-hidden="true">→</span>
        </Link>
      ))}
    </div>
  );
}

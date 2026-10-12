/**
 * Public booking layout (Phase 2): its own shell — no staff nav, its own fonts
 * and theme tokens (theme.css, white-label). Everything under /reservar is
 * public (route-decision PUBLIC_PREFIXES); the page itself only reads the
 * catalog + free slots, and the write goes through POST /api/reservar.
 */
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Bricolage_Grotesque, Inter_Tight } from "next/font/google";
import "./theme.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});
const body = Inter_Tight({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Reservá en VAIG",
  description: "Elegí tu servicio, tu profesional y tu horario. Reservá en un minuto.",
  robots: { index: true, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#efe9e2",
  width: "device-width",
  initialScale: 1,
};

export default function ReservarLayout({ children }: { children: ReactNode }) {
  return <div className={`rsv-root ${display.variable} ${body.variable}`}>{children}</div>;
}

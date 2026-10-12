import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "VAIG v2",
  // User-facing copy is Spanish (CLAUDE.md language rule).
  description: "Agenda, recordatorios y reactivación para VAIG",
  // iOS home-screen web app: standalone display + the home-screen icon.
  // (The manifest covers Android/desktop; iOS reads these apple-* hints.)
  appleWebApp: {
    capable: true,
    title: "VAIG",
    statusBarStyle: "default",
  },
  icons: {
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0d7d86",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}

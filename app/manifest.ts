import type { MetadataRoute } from "next";

/**
 * PWA manifest (2026-08-20). Makes "Add to Home Screen" install VAIG as a
 * standalone app (its own window, no browser chrome) with a real name and
 * icon instead of a page snapshot. This is cosmetic for auth — the OTP-code
 * login (not a magic link) is what actually keeps the home-screen web-clip
 * signed in on iOS (see lib/auth/actions.ts).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "VAIG — Agenda y recordatorios",
    short_name: "VAIG",
    description: "Agenda, recordatorios y reactivación de clientas.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0d7d86",
    lang: "es-UY",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

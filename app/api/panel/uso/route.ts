/**
 * POST /api/panel/uso — which panel screen just got opened
 * (docs/booking-analytics.md: "measure what the team actually uses to decide
 * what's worth maintaining"). Staff-gated; route names only — the shared
 * team logins make person-level attribution meaningless, so none is kept.
 */
import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth/require-staff";
import { serviceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/** The trackable screens — anything else is dropped (no free-text routes). */
const PANEL_ROUTES = new Set([
  "/clientas",
  "/por-confirmar",
  "/nueva-sesion",
  "/cuponeras",
  "/clientes",
  "/sin-identificar",
  "/reactivacion",
  "/resenas",
  "/ajustes",
  "/horarios",
  "/servicios",
  "/profesionales",
  "/metricas",
]);

export async function POST(request: Request) {
  const auth = await requireStaff();
  if ("error" in auth) return new NextResponse(null, { status: 401 });

  let route = "";
  try {
    const body = (await request.json()) as { route?: unknown };
    route = typeof body.route === "string" ? body.route : "";
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  // Normalize subroutes to their screen ("/nueva-sesion/123/editar" counts as
  // "/nueva-sesion").
  const screen = "/" + (route.split("/")[1] ?? "");
  if (!PANEL_ROUTES.has(screen)) return new NextResponse(null, { status: 204 });

  const { error } = await serviceClient().from("panel_events").insert({ route: screen });
  if (error) console.error(`panel_events insert failed: ${error.message}`);
  return new NextResponse(null, { status: 204 });
}

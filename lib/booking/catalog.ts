/**
 * Public booking catalog reads (Phase 2): the active items grouped by
 * category, and the professionals who provide an item (priority order) with
 * their display names. Runs server-side with the service role — the anon key
 * never reaches the browser and there is no anon RLS on the catalog.
 * Returns only public information (item names/prices/durations, staff first
 * names) — never client data.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { type CatalogGroup, type CatalogItem, groupCatalog } from "./public-flow";

export async function fetchCatalog(db: SupabaseClient): Promise<CatalogGroup[]> {
  const res = await db
    .from("booking_services")
    .select("id, name, category, duration_min, price_uyu, deposit_uyu, package_sessions")
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (res.error) throw new Error(`fetchCatalog: ${res.error.message}`);
  const items: CatalogItem[] = (res.data ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    category: (r.category as string | null) ?? "Otros",
    durationMin: r.duration_min as number,
    priceUyu: (r.price_uyu as number | null) ?? null,
    depositUyu: (r.deposit_uyu as number | null) ?? null,
    packageSessions: (r.package_sessions as number | null) ?? null,
  }));
  return groupCatalog(items);
}

export type Provider = { staffId: string; label: string };

/**
 * Who provides which item: { itemId → providers in priority order }. One read
 * for the whole catalog so the page can render step 2 without a round-trip.
 */
export async function fetchProviders(db: SupabaseClient): Promise<Record<string, Provider[]>> {
  const [links, staff] = await Promise.all([
    db
      .from("staff_services")
      .select("booking_service_id, staff_id, priority")
      .order("priority", { ascending: true }),
    db.from("staff").select("id, name").eq("active", true),
  ]);
  if (links.error) throw new Error(`fetchProviders: ${links.error.message}`);
  if (staff.error) throw new Error(`fetchProviders staff: ${staff.error.message}`);
  const label = new Map<string, string>();
  for (const s of staff.data ?? []) label.set(s.id as string, s.name as string);
  const out: Record<string, Provider[]> = {};
  for (const l of links.data ?? []) {
    const name = label.get(l.staff_id as string);
    if (!name) continue; // inactive staff never offered
    (out[l.booking_service_id as string] ??= []).push({ staffId: l.staff_id as string, label: name });
  }
  return out;
}

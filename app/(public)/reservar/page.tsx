/**
 * Public booking page (Phase 2, the internal booking plan §"Página pública").
 * Server-renders the catalog (items by category, who provides each) and hands
 * the 5-step flow to the client component. A client who already verified
 * their phone (cookie session) skips the code step.
 */
import { createClient, hasSupabaseEnv } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { clientNameByPhone } from "@/lib/booking/reserve-ports";
import { fetchCatalog, fetchProviders } from "@/lib/booking/catalog";
import { fetchClientBalances, type ClientBalance } from "@/lib/packages/read";
import { BookingFlow } from "./BookingFlow";
import s from "./booking.module.css";

export const dynamic = "force-dynamic";

export default async function ReservarPage() {
  if (!hasSupabaseEnv()) {
    return <main className={s.page}><p style={{ padding: 24 }}>Las reservas no están disponibles todavía.</p></main>;
  }

  let knownPhone: string | null = null;
  try {
    const { data } = await createClient().auth.getUser();
    const phone = (data.user?.app_metadata as { phone?: unknown } | undefined)?.phone;
    knownPhone = typeof phone === "string" && phone ? phone : null;
  } catch {
    knownPhone = null;
  }

  try {
    const db = serviceClient();
    const [catalog, allProviders, balances, knownName] = await Promise.all([
      fetchCatalog(db),
      fetchProviders(db),
      // A verified client sees what she still has to book (cuponera balance)…
      knownPhone ? fetchClientBalances(db, knownPhone) : Promise.resolve([] as ClientBalance[]),
      // …and is greeted by name instead of being asked for it again. A hiccup
      // here must not fail the page — degrade to the ask-name UI (same
      // philosophy as the verify-code route).
      knownPhone ? clientNameByPhone(db, knownPhone).catch(() => null) : Promise.resolve(null),
    ]);
    // Ship only the links of items actually offered (inactive items are noise).
    const providers: typeof allProviders = {};
    for (const g of catalog) for (const it of g.items) providers[it.id] = allProviders[it.id] ?? [];
    return (
      <main className={s.page}>
        <BookingFlow catalog={catalog} providers={providers} knownPhone={knownPhone} knownName={knownName} balances={balances} />
      </main>
    );
  } catch {
    return (
      <main className={s.page}>
        <p style={{ padding: 24 }}>No pudimos cargar los servicios. Probá de nuevo en un rato.</p>
      </main>
    );
  }
}

/**
 * Unmatched view (PRD FR-4 Unmatched, §7.3, issue E3-T3): the queue of
 * sessions with no client. Each row can be resolved to an existing client
 * (ambiguous candidates suggested on top) or to a new client created inline;
 * resolving learns an alias and retroactively matches the rest of the queue.
 * Server-rendered read; the interactive row is a client component that calls
 * Server Actions.
 */
import { createClient, hasSupabaseEnv } from "@/lib/supabase/server";
import {
  type AliasLite,
  allCandidatesFor,
  previewTokens,
  type UnmatchedSession,
} from "@/lib/unmatched/resolve";
import { ErrorBanner } from "@/app/(app)/_components/Banners";
import { type QueueItem, UnmatchedList } from "./UnmatchedList";

export const dynamic = "force-dynamic";

/**
 * Full phone included (issue #80, owner decision 2026-07-23, reversing the
 * earlier REC1 last-4 projection): the operator searches by phone and needs
 * it to disambiguate homonyms, the app is staff-authenticated, and the
 * Clientas screen already ships full phones to the browser for its wa.me
 * buttons — the projection here protected nothing anymore.
 */
export type ClientOption = { id: string; full_name: string; phone: string };

export default async function SinIdentificarPage() {
  if (!hasSupabaseEnv()) {
    return <p>La app no está configurada todavía.</p>;
  }
  const supabase = createClient();
  const [unmatchedRes, clientsRes, aliasesRes] = await Promise.all([
    // Cap note (issue #95): the nav badge counts upcoming rows UNBOUNDED,
    // while this page renders at most 500 — past 500 queued rows the
    // "Todas" chip undercounts vs reality. The view sorts starts_at desc,
    // so upcoming rows always fit; only the historic tail can truncate.
    supabase.from("v_unmatched").select("*").limit(500),
    supabase.from("clients").select("id, full_name, phone").order("full_name"),
    supabase.from("aliases").select("client_id, alias_tokens"),
  ]);

  const loadError = unmatchedRes.error?.message ?? null;
  const sessions = (unmatchedRes.data ?? []) as UnmatchedSession[];
  const clients = (clientsRes.data ?? []) as ClientOption[];
  const aliases = (aliasesRes.data ?? []) as AliasLite[];
  const clientById = new Map(clients.map((c) => [c.id, c]));

  return (
    <section style={{ paddingTop: 16 }}>
      <h2 style={{ fontSize: 20, margin: "0 0 4px" }}>Sin identificar</h2>
      <p style={{ fontSize: 13, color: "#777", margin: "0 0 16px" }}>
        {sessions.length} sesiones en cola. Al asignar una clienta se aprende
        un alias que resuelve las demás con el mismo nombre.
      </p>

      {loadError ? (
        <div style={{ marginBottom: 16 }}>
          <ErrorBanner>No se pudo cargar la cola.</ErrorBanner>
        </div>
      ) : null}

      <UnmatchedList
        items={sessions.map((s): QueueItem => ({
          session: s,
          // Aliases first, then full-name hits (issue #83) — both are strict
          // token-subset rules; the operator always confirms.
          candidates: allCandidatesFor(s, aliases, clients)
            .map((id) => clientById.get(id))
            .filter((c): c is ClientOption => Boolean(c)),
          suggestedAlias: previewTokens(s),
        }))}
        clients={clients}
        nowMs={Date.now()}
      />
    </section>
  );
}

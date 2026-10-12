"use server";

/**
 * Server Actions for manual resolution of unmatched sessions (PRD §7.3,
 * issue E3-T3). These MUTATE production: assign a client, learn an alias,
 * and apply it retroactively to every still-queued session. Matching logic
 * is architect-owned. Runs server-side with the service role — the browser
 * never sees the key.
 */
import { revalidatePath } from "next/cache";
import { tokens } from "../normalize";
import { serviceClient } from "../supabase/service";
import { requireStaff } from "../auth/require-staff";
import { findOrCreateClient } from "../clients/upsert";
import { aliasConflictsWith, aliasMatches, matchableText } from "./resolve";

/**
 * Assign `clientId` to the session, learn an alias from the (editable)
 * tokens, and retroactively match every still-queued session the new alias
 * fits (§7.3). Returns how many sessions were resolved (the one + retro).
 */
export async function resolveSession(input: {
  sessionId: string;
  clientId: string;
  /** Editable alias tokens; falls back to the session's own tokens. */
  aliasTokens: string[];
  rawTitle: string;
  source: string;
}): Promise<{ resolved: number } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const db = serviceClient();
  const aliasTokens = input.aliasTokens.length > 0
    ? input.aliasTokens
    : tokens(matchableText(input.source, input.rawTitle));
  const rawAlias = aliasTokens.join(" ");

  // Guard the schema invariant "an alias cannot point to two clients": if
  // this alias already belongs to a DIFFERENT client, refuse — assigning the
  // session to a new client while the alias (and future syncs) point
  // elsewhere would split one identity across two people (§7.3, init.sql:24).
  if (aliasTokens.length > 0) {
    const { data: existing, error: exErr } = await db
      .from("aliases")
      .select("client_id")
      .eq("raw_alias", rawAlias)
      .maybeSingle();
    if (exErr) throw new Error(`alias check: ${exErr.message}`);
    if (aliasConflictsWith(existing?.client_id ?? null, input.clientId)) {
      return {
        error:
          "Ese alias ya pertenece a otra clienta. Editá las palabras del " +
          "alias para que sean distintas, o asigná esta sesión a esa clienta.",
      };
    }
  }

  // 1. Resolve the session itself (manual). Guards: still-unmatched (a
  //    concurrent resolution can't be overwritten) AND not dismissed (a
  //    concurrently-dismissed row must not become someone's session — it
  //    would surface in v_client_status and could fire a reminder). The
  //    0-row check stops the alias learning + retro-match too.
  const { data: resolvedRows, error: matchErr } = await db
    .from("sessions")
    .update({ client_id: input.clientId, match_method: "manual" })
    .eq("id", input.sessionId)
    .is("client_id", null)
    .is("dismissed_at", null)
    .select("id");
  if (matchErr) throw new Error(`resolve: ${matchErr.message}`);
  if (!resolvedRows || resolvedRows.length === 0) {
    return {
      error:
        "Esta sesión ya fue resuelta o descartada por otra persona. " +
        "Recargá la página para ver el estado actual.",
    };
  }

  // 2. Learn the alias. The conflict check above guarantees any existing row
  //    already belongs to this client, so skipping on conflict is safe.
  if (aliasTokens.length > 0) {
    const { error: aliasErr } = await db.from("aliases").upsert(
      {
        client_id: input.clientId,
        raw_alias: rawAlias,
        alias_tokens: aliasTokens,
        source: "manual",
      },
      { onConflict: "raw_alias", ignoreDuplicates: true },
    );
    if (aliasErr) throw new Error(`learn alias: ${aliasErr.message}`);
  }

  // 3. Retroactive re-match: apply the new alias to every still-queued
  //    session (§7.3). Read the queue, filter with the subset rule, assign.
  //    Dismissed rows are not sessions — never re-match them (issue #48).
  let retro = 0;
  if (aliasTokens.length > 0) {
    const { data: queued, error: qErr } = await db
      .from("sessions")
      .select("id, raw_title, source")
      .is("client_id", null)
      .neq("status", "cancelled")
      .is("dismissed_at", null)
      .neq("id", input.sessionId);
    if (qErr) throw new Error(`queue read: ${qErr.message}`);

    const toMatch = (queued ?? [])
      .filter((s) =>
        aliasMatches(aliasTokens, tokens(matchableText(s.source, s.raw_title)))
      )
      .map((s) => s.id);

    if (toMatch.length > 0) {
      const { error: rErr } = await db
        .from("sessions")
        .update({ client_id: input.clientId, match_method: "alias" })
        .in("id", toMatch)
        .is("client_id", null)
        .is("dismissed_at", null);
      if (rErr) throw new Error(`retro match: ${rErr.message}`);
      retro = toMatch.length;
    }
  }

  revalidatePath("/sin-identificar");
  revalidatePath("/clientas");
  return { resolved: 1 + retro };
}

/**
 * Create a new client (name + phone) and immediately resolve the session to
 * them (§7.3 inline "create new client"). The phone is normalized; an
 * invalid phone is rejected. Then delegates to resolveSession for the alias
 * + retroactive match.
 */
export async function createClientAndResolve(input: {
  sessionId: string;
  fullName: string;
  phone: string;
  isFirstVisit: boolean;
  aliasTokens: string[];
  rawTitle: string;
  source: string;
}): Promise<{ resolved: number } | { error: string }> {
  const auth = await requireStaff();
  if ("error" in auth) return { error: auth.error };
  const db = serviceClient();

  // Single client-creation path (phone uniqueness + conflict/reuse/create +
  // is_first_visit-on-create). Fixes the prior drift where this flow, unlike
  // Nueva sesión, never set is_first_visit.
  const resolved = await findOrCreateClient(db, {
    fullName: input.fullName,
    phone: input.phone,
    isFirstVisit: input.isFirstVisit,
  });
  if ("error" in resolved) return { error: resolved.error };

  return resolveSession({
    sessionId: input.sessionId,
    clientId: resolved.clientId,
    aliasTokens: input.aliasTokens,
    rawTitle: input.rawTitle,
    source: input.source,
  });
}


/**
 * Mark a queued row as "not a session" (issue #48): bills, notes and other
 * non-events the §7.0 patterns didn't catch. Stamps dismissed_at, which the
 * sync never CLEARS (since issue #84 its self-heal also stamps it on rows
 * the classifier now discards) — so a dismissal survives every future sync.
 * Only unmatched rows are dismissable (the guard makes a stray id a no-op).
 */
export async function dismissSession(sessionId: string): Promise<void> {
  const auth = await requireStaff();
  if ("error" in auth) throw new Error(auth.error);
  const db = serviceClient();
  const { error } = await db
    .from("sessions")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", sessionId)
    .is("client_id", null);
  if (error) throw new Error(`dismiss: ${error.message}`);
  revalidatePath("/sin-identificar");
}

/**
 * Clients view (PRD FR-4, issue E3-T2): a table over v_client_status with
 * partial name/phone search, the asked-to-reschedule quick filter, a
 * next-session badge per row, and a health indicator from job_runs.
 * Everything renders server-side — the anon key never reaches the browser.
 */
import { createClient, hasSupabaseEnv } from "@/lib/supabase/server";
import {
  askedToReschedule,
  type ClientStatusRow,
  formatWhen,
  type GhostSession,
  ghostIsTomorrow,
  health,
  type JobRun,
  needsRebookFollowup,
  operationalCompare,
  type PastSession,
  pendingConfirmTomorrow,
  rebookingRate,
} from "@/lib/clients/status";
import {
  joinedClientName,
  externalCoveredKeys,
  METRICS_WINDOW_DAYS,
  missedReminders,
  type RemindedSession,
  reminderMetrics,
  RESPONSE_TARGET,
} from "@/lib/clients/metrics";

/** Shape of the joined "no aviso" query row. `clients` is an object at runtime
 *  but the generic types declare an array — joinedClientName handles both. */
type MissedSessionRow = {
  id: string;
  client_id: string;
  starts_at: string;
  reminder_sent_at: string | null;
  status: string;
  source: string | null;
  clients: { full_name: string } | { full_name: string }[] | null;
};
import { ErrorBanner } from "@/app/(app)/_components/Banners";
import { BORDER_SOFT, INK, MUTED, SURFACE } from "@/lib/ui/theme";
import ClientTable from "./ClientTable";
import { DayActionStrip } from "./DayActionStrip";

export const dynamic = "force-dynamic";

export default async function ClientasPage({
  searchParams,
}: {
  searchParams: { filtro?: string };
}) {
  if (!hasSupabaseEnv()) {
    return <p>La app no está configurada todavía.</p>;
  }
  const filtro = searchParams.filtro;
  const nowMs = Date.now();

  const supabase = createClient();
  const metricsFromIso = new Date(
    nowMs - METRICS_WINDOW_DAYS * 86_400_000,
  ).toISOString();
  const [
    statusRes,
    ghostsRes,
    jobsRes,
    remindedRes,
    rebookRes,
    missedRes,
    externalRes,
    pendingRes,
  ] = await Promise.all([
    supabase
      .from("v_client_status")
      .select("*")
      .order("full_name", { ascending: true }),
    // Upcoming unidentified sessions (issue #99): interleaved as ghost
    // rows so the day agenda tells the whole truth. Never the historic
    // backlog — that lives in Sin identificar.
    supabase
      .from("v_unmatched")
      .select("id, raw_title, starts_at")
      .gte("starts_at", new Date(nowMs).toISOString()),
    supabase
      .from("job_runs")
      .select("job, ok, finished_at")
      .order("finished_at", { ascending: false })
      .limit(200),
    supabase
      .from("sessions")
      .select("reminder_sent_at, confirmed_at, status")
      .gte("reminder_sent_at", metricsFromIso),
    // Rebooking pulse (issue #107): past sessions with a "had a later one"
    // flag; the ratio + grace live in rebookingRate.
    supabase.from("v_rebooking_past").select("client_id, starts_at, has_later"),
    // "No aviso" alert: tomorrow's sessions with their reminder state, to catch
    // the ones that never got a reminder (the gap behind "she says she never
    // received it"). Bounded to a [now, now+48h] band; missedReminders narrows
    // to the exact next-local-day window. External-SOURCE rows excluded here;
    // External-COVERED manual twins are excluded below (they're reminded by
    // External, so their null reminder is by design, not a miss).
    supabase
      .from("sessions")
      .select("id, client_id, starts_at, reminder_sent_at, status, source, clients!inner(full_name)")
      .eq("status", "scheduled")
      .neq("source", "external")
      .is("reminder_sent_at", null)
      .not("client_id", "is", null)
      .gte("starts_at", new Date(nowMs).toISOString())
      .lt("starts_at", new Date(nowMs + 48 * 3_600_000).toISOString()),
    // Scheduled External sessions in the same band, per client+day — a manual
    // twin sharing a client's Montevideo day is External-covered and must NOT
    // be flagged (same rule as send-reminders' fetchExternalCovered, issue #69).
    supabase
      .from("sessions")
      .select("client_id, starts_at")
      .eq("source", "external")
      .eq("status", "scheduled")
      .not("client_id", "is", null)
      .gte("starts_at", new Date(nowMs).toISOString())
      .lt("starts_at", new Date(nowMs + 48 * 3_600_000).toISOString()),
    // Public reservations the team hasn't confirmed yet (Phase 2): the view
    // doesn't carry the flag, so mark the matching next-session rows here.
    supabase
      .from("sessions")
      .select("id")
      .eq("pending_confirmation", true)
      .eq("status", "scheduled")
      .gte("starts_at", new Date(nowMs).toISOString()),
  ]);

  // A failed query (e.g. the DB isn't migrated yet) must read as an error,
  // not as "zero clients". The ghosts read counts too (issue #99 review):
  // silently dropping it would make the agenda lie by omission again —
  // the exact problem ghost rows exist to fix.
  const loadError = statusRes.error?.message ?? ghostsRes.error?.message ??
    pendingRes.error?.message ?? null;
  const pendingIds = new Set(
    ((pendingRes.data ?? []) as { id: string }[]).map((r) => r.id),
  );
  const rows = ((statusRes.data ?? []) as ClientStatusRow[]).map((r) =>
    r.next_session_id && pendingIds.has(r.next_session_id)
      ? { ...r, next_pending_confirmation: true }
      : r,
  );
  const allGhosts = (ghostsRes.data ?? []) as GhostSession[];
  // Ghost rows only in the agenda-like views (issue #99): a narrowed chip
  // ("Sin confirmar mañana", "Pidió reagendar") is a client worklist and
  // must not carry unrelated unidentified rows.
  const ghosts = (!filtro || filtro === "proxima") ? allGhosts : [];
  const jobs = (jobsRes.data ?? []) as JobRun[];
  const healthEntries = health(jobs, nowMs);
  const metrics = reminderMetrics(
    (remindedRes.data ?? []) as RemindedSession[],
    nowMs,
  );
  // "No aviso" for tomorrow: sessions whose reminder never went out. The row's
  // full_name comes from the joined clients row (PostgREST nests it).
  const missed = missedReminders(
    ((missedRes.data ?? []) as MissedSessionRow[]).map((r) => ({
      id: r.id,
      client_id: r.client_id,
      full_name: joinedClientName(r.clients),
      starts_at: r.starts_at,
      reminder_sent_at: r.reminder_sent_at,
      status: r.status,
      source: r.source,
    })),
    nowMs,
    externalCoveredKeys(
      (externalRes.data ?? []) as { client_id: string; starts_at: string }[],
    ),
  );

  // The typed search moved client-side (issue #70): chips count over the
  // full set; the live query filters only what the user sees.
  const base = rows;
  const conProxima = base.filter((r) => r.next_session_at !== null);
  const sinConfirmarManana = base.filter((r) =>
    pendingConfirmTomorrow(r, nowMs),
  );
  const reagendar = base.filter(askedToReschedule);
  // Retention follow-up (issue #107): attended recently, left without a next
  // date, not yet cold. The early-catch worklist.
  const sinRereserva = base.filter(needsRebookFollowup);

  const rebook = rebookingRate(
    (rebookRes.data ?? []) as PastSession[],
    nowMs,
  );

  // The day's pending work (issue #101): actionable counts over the full
  // set, independent of the active chip.
  const dayActions = {
    reagendar: reagendar.length,
    sinConfirmar: sinConfirmarManana.length,
    sinIdentificar: allGhosts.filter((g) => ghostIsTomorrow(g, nowMs)).length,
  };

  const filtered =
    filtro === "proxima"
      ? conProxima
      : filtro === "manana"
      ? sinConfirmarManana
      : filtro === "reagendar"
      ? reagendar
      : filtro === "rereserva"
      ? sinRereserva
      : base;
  const visible = [...filtered].sort(operationalCompare);

  const withQuery = (params: string) =>
    params ? `/clientas?${params}` : "/clientas";
  // Segmented control (2026-08-19): the filters used to be pills that looked
  // just like the nav, blurring "filter this table" with "go to a screen".
  // Now they're one segmented group with a shared background; the active
  // segment gets a raised white chip. (Server component — the segments are
  // <a> links carrying ?filtro=, so state lives in the URL.)
  const CHIP_BASE = {
    display: "inline-flex",
    alignItems: "center",
    minHeight: 44, // project tap-target rule (these are primary touch controls)
    padding: "0 12px",
    borderRadius: 8,
    fontSize: 13.5,
    fontWeight: 600,
    textDecoration: "none",
    color: MUTED,
    whiteSpace: "nowrap",
    flexShrink: 0,
  } as const;
  const CHIP_ACTIVE = {
    background: "#fff",
    color: INK,
    boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
  } as const;
  const chips = [
    { key: undefined, label: `Todas (${base.length})`, href: withQuery("") },
    {
      key: "proxima",
      label: `Con próxima (${conProxima.length})`,
      href: withQuery("filtro=proxima"),
    },
    {
      key: "manana",
      label: `Sin confirmar mañana (${sinConfirmarManana.length})`,
      href: withQuery("filtro=manana"),
    },
    {
      key: "reagendar",
      label: `Pidió reagendar (${reagendar.length})`,
      href: withQuery("filtro=reagendar"),
    },
    {
      key: "rereserva",
      label: `Sin re-reservar (${sinRereserva.length})`,
      href: withQuery("filtro=rereserva"),
    },
  ] as const;

  return (
    <section style={{ paddingTop: 16 }}>
      <h2 style={{ fontSize: 20, margin: "0 0 12px" }}>Clientas</h2>

      {/* Today's pending work (issue #101): the action strip — never the
          calm "todo al día" on top of a load failure (review), so it only
          renders when the data actually loaded. */}
      {loadError ? null : <DayActionStrip actions={dayActions} />}

      {loadError ? (
        <div style={{ marginBottom: 16 }}>
          <ErrorBanner>
            No se pudieron cargar las clientas. Puede que la base todavía no
            esté migrada.
          </ErrorBanner>
        </div>
      ) : null}

      {/* §11 KPI strip: button-response rate on reminders — the agreed
          no-show proxy (real attendance is unmeasurable; calendar is
          read-only by contract). */}
      <div
        style={{
          border: `1px solid ${BORDER_SOFT}`,
          background: SURFACE,
          borderRadius: 12,
          padding: "10px 14px",
          fontSize: 13,
          color: MUTED,
          marginBottom: 12,
          display: "flex",
          flexWrap: "wrap",
          gap: "6px 12px",
          alignItems: "baseline",
        }}
      >
        <strong style={{ color: INK, fontSize: 12.5 }}>
          Recordatorios · últimos {METRICS_WINDOW_DAYS} días
        </strong>
        {metrics.sent === 0 || metrics.responseRate === null ? (
          <span>sin envíos todavía</span>
        ) : (
          <>
            <span>enviados {metrics.sent}</span>
            <span>confirmaron {metrics.confirmed}</span>
            <span>pidieron reagendar {metrics.rescheduled}</span>
            <span
              style={{
                fontWeight: 700,
                color:
                  metrics.responseRate >= RESPONSE_TARGET
                    ? "#1a7a1a"
                    : "#a02525",
              }}
            >
              respuesta {Math.round(metrics.responseRate * 100)}% (meta ≥
              {Math.round(RESPONSE_TARGET * 100)}%)
            </span>
          </>
        )}
        {/* Rebooking pulse (issue #107): the retention rate — of the
            attended sessions, how many led to another one. */}
        {rebook.rate !== null ? (
          <span title="De las sesiones ya atendidas, cuántas tuvieron otra sesión después (cualquier canal). Últimos 60 días.">
            <strong style={{ color: INK }}>re-reserva</strong>{" "}
            {Math.round(rebook.rate * 100)}%
          </span>
        ) : null}
      </div>

      {/* "No aviso" alert: tomorrow's sessions whose reminder never went out.
          Only shows AFTER the last batch (21:00) — reminders go out at 16:00 and
          a 21:00 catch-up, so before 21:00 a null reminder isn't yet a miss
          (missedReminders gates on the hour). After 21:00 it's a genuine
          failure. The agenda badge shows "pendiente" either way, so this is
          otherwise invisible; surface these so the desk can message by hand. */}
      {missed.length > 0 ? (
        <div
          role="alert"
          style={{
            background: "#fdecea",
            border: "1px solid #f5c6cb",
            color: "#611a15",
            borderRadius: 10,
            padding: "12px 14px",
            marginBottom: 16,
            fontSize: 14,
          }}
        >
          <strong>
            ⚠ {missed.length}{" "}
            {missed.length === 1
              ? "clienta de mañana sin recordatorio enviado"
              : "clientas de mañana sin recordatorio enviado"}
          </strong>
          <div style={{ marginTop: 6, lineHeight: 1.7 }}>
            {missed.map((m) => (
              <span key={m.id} style={{ display: "block" }}>
                {m.full_name} · {formatWhen(m.starts_at)}
              </span>
            ))}
          </div>
          <div style={{ marginTop: 6, fontSize: 13, color: "#8a4b45" }}>
            El aviso automático de hoy ya salió y a estas no les llegó.
            Conviene escribirles a mano.
          </div>
        </div>
      ) : null}

      {/* Health indicator: last OK run per job (PRD FR-4). */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          fontSize: 13,
          color: MUTED,
          marginBottom: 16,
        }}
      >
        {healthEntries.map((e) =>
          e.state === "never" ? (
            <span key={e.job}>
              <strong style={{ color: "#a02525" }}>○</strong>{" "}
              {e.job}: sin corridas ⚠
            </span>
          ) : (
            <span key={e.job}>
              <strong
                style={{ color: e.state === "ok" ? "#1a7a1a" : "#7a5200" }}
              >
                ●
              </strong>{" "}
              {e.job}: {formatWhen(e.finished_at)}
              {e.state === "stale" ? " ⚠" : ""}
            </span>
          ),
        )}
      </div>

      {/* Operational filters — one segmented control (shared background). */}
      <div
        style={{
          display: "flex",
          // One line with sideways scroll — wrapping turned this into an
          // uneven gray blob on phones (2026-09-02).
          flexWrap: "nowrap",
          overflowX: "auto",
          gap: 3,
          padding: 4,
          borderRadius: 12,
          background: "#ece7db",
          marginBottom: 16,
        }}
      >
        {chips.map((chip) => {
          const active = chip.key === filtro;
          return (
            <a
              key={chip.label}
              href={chip.href}
              style={{
                ...CHIP_BASE,
                ...(active ? CHIP_ACTIVE : {}),
              }}
            >
              {chip.label}
            </a>
          );
        })}
      </div>

      {/* Context line for the retention worklist (issue #107). */}
      {filtro === "rereserva" ? (
        <p style={{ fontSize: 13, color: "#555", margin: "0 0 8px" }}>
          Se atendieron hace entre 3 y 21 días y se fueron sin próxima
          sesión. Ofreceles fecha antes de que se enfríen — escribiles desde
          el número del local.
        </p>
      ) : null}

      {/* Live search + table (issue #70): client component over
          server-rendered rows. */}
      <ClientTable
        rows={visible}
        ghosts={ghosts}
        nowMs={nowMs}
        rebookMode={filtro === "rereserva"}
      />

    </section>
  );
}

"use client";

/**
 * Live search over the clients table (issue #70): filtering happens on
 * every keystroke, client-side, over rows the SERVER already rendered for
 * the active chip — no API route, no anon key, no new data exposure (the
 * same rows shipped in the HTML before this component existed). Matching
 * reuses the same pure `matchesQuery` the server used, so search semantics
 * (partial name, phone with or without leading 0) are identical.
 *
 * Day grouping (issue #97): the operationally-sorted rows are split into
 * Montevideo-day sections with sticky headers ("Hoy · lun 27/07 · N"), so
 * each day's bookings read as a block. One table per group with a shared
 * fixed column layout keeps the columns aligned across sections — a single
 * table can't give us sticky headers (they would need to stick inside the
 * horizontal-overflow wrapper, where vertical sticky never engages).
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  BADGE_LABEL,
  type ClientStatusRow,
  type DayGroup,
  formatTimeOnly,
  formatWhen,
  ghostMatchesQuery,
  type GhostSession,
  groupAgendaByDay,
  matchesQuery,
  nextAgainLabel,
  type SessionBadge,
  sessionBadge,
} from "@/lib/clients/status";
import { reschedWaLink } from "@/lib/clients/resched-link";
import { rebookWaLink } from "@/lib/reactivation/walink";
import { dismissMatchedSession } from "@/lib/sessions/actions";
import { ACCENT, BORDER, CONTROL_H, INK, MUTED } from "@/lib/ui/theme";
import { Button } from "@/app/(app)/_components/Button";

const BADGE_STYLE: Record<SessionBadge, { bg: string; fg: string }> = {
  // Warm amber, distinct from the client-side "pendiente": the TEAM has to act.
  unconfirmed: { bg: "#fde8d7", fg: "#8a3f0b" },
  confirmed: { bg: "#e4f5e4", fg: "#1a7a1a" },
  pending: { bg: "#fff3d6", fg: "#7a5200" },
  reschedule: { bg: "#e6effd", fg: "#1c5cab" },
  // Neutral on purpose (issue #89): External owns that reminder — nothing
  // for the team to chase, so no warning color.
  external: { bg: "#f0f0f0", fg: "#555" },
  none: { bg: "#f0f0f0", fg: "#777" },
};

/** Shared fixed column widths so every group's table aligns (issue #97). */
const COLS = (
  <colgroup>
    <col style={{ width: "38%" }} />
    <col style={{ width: "31%" }} />
    <col style={{ width: "23%" }} />
    {/* actions (the ⋮ menu) — narrow, far right */}
    <col style={{ width: "8%" }} />
  </colgroup>
);

function Badge({ kind }: { kind: SessionBadge }) {
  const s = BADGE_STYLE[kind];
  // Neutral states (External / none) get a quieter chip so they stop competing
  // with the actionable ones (confirmada / pendiente / reagendar) — the eye goes
  // to what needs attention (UX 2026-08-18). External repeats on nearly every row.
  const quiet = kind === "external" || kind === "none";
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: quiet ? 11.5 : 12.5,
        fontWeight: quiet ? 500 : 600,
        borderRadius: 999,
        padding: quiet ? "1px 8px" : "2px 10px",
        background: s.bg,
        color: s.fg,
        // No nowrap (issue #97 review): inside the fixed-width column a
        // long pill wraps to a second line instead of overflowing the page.
      }}
    >
      {BADGE_LABEL[kind]}
    </span>
  );
}

/** True for the "today" group — its label starts with "Hoy". */
function isTodayGroup(group: DayGroup): boolean {
  return group.label.startsWith("Hoy");
}

/**
 * The day label sits OUTSIDE the day card (2026-08-27 redesign): a plain,
 * scrolling heading above each card rather than a sticky bar, so the cards
 * read as separate blocks. "Hoy" gets a filled pill; today's whole label is
 * tinted with the accent.
 */
function GroupHeader({ group }: { group: DayGroup }) {
  const n = group.items.length;
  const noun = group.key === "none"
    ? (n === 1 ? "clienta" : "clientas")
    : (n === 1 ? "sesión" : "sesiones");
  const today = isTodayGroup(group);
  // For today, show a "HOY" pill and drop the "Hoy · " prefix from the label.
  const restLabel = today ? group.label.replace(/^Hoy\s*·\s*/, "") : group.label;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        flexWrap: "wrap",
        gap: 8,
        padding: "0 2px 8px",
        fontSize: 13,
        fontWeight: 800,
        color: today ? ACCENT : INK,
      }}
    >
      {today ? (
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 800,
            letterSpacing: "0.06em",
            background: ACCENT,
            color: "#fff",
            borderRadius: 5,
            padding: "2px 7px",
          }}
        >
          HOY
        </span>
      ) : null}
      <span>{restLabel}</span>
      <span style={{ fontWeight: 600, color: MUTED }}>
        · {n} {noun}
      </span>
      {group.ghosts > 0 ? (
        <span style={{ color: "#a02525", fontWeight: 700 }}>
          · {group.ghosts} sin identificar
        </span>
      ) : null}
    </div>
  );
}

function GhostRow({ g }: { g: GhostSession }) {
  return (
    <tr style={{ background: "#f7f5f1" }}>
      <td
        style={{
          padding: "10px 8px 10px 11px",
          verticalAlign: "top",
          overflowWrap: "break-word",
          color: "#999",
          fontStyle: "italic",
          // Accent left stripe (UX 2026-08-18): separates the unresolved
          // free-text rows from the resolved clients above/below them. An inset
          // box-shadow (not a border) so the stripe follows the card's rounded
          // corner when a ghost is the first/last row — a border-left would nick
          // the corner square. padding-left absorbs the 3px the border used.
          boxShadow: "inset 3px 0 0 #c96b8e",
        }}
      >
        &ldquo;{g.raw_title.trim()}&rdquo;
      </td>
      <td style={{ padding: "10px 8px", verticalAlign: "top" }}>
        <span
          style={{
            display: "inline-block",
            fontSize: 12.5,
            fontWeight: 600,
            borderRadius: 999,
            padding: "2px 10px",
            background: "#fdecea",
            color: "#a02525",
          }}
        >
          sin identificar
        </span>
        <div style={{ color: "#999", fontSize: 12.5, marginTop: 4 }}>
          {formatTimeOnly(g.starts_at)}
        </div>
        <div style={{ marginTop: 6 }}>
          <Button
            variant="ghost"
            size="sm"
            href="/sin-identificar"
          >
            Identificar →
          </Button>
        </div>
      </td>
      <td style={{ padding: "10px 8px", verticalAlign: "top", color: "#bbb" }}>
        —
      </td>
      {/* Ghost rows have no session actions — align with the actions column. */}
      <td style={{ padding: "10px 4px" }} />
    </tr>
  );
}

function WaAction({ href, label = "Escribile 📲" }: { href: string; label?: string }) {
  return (
    <div style={{ marginTop: 6 }}>
      <Button
        variant="whatsapp"
        size="sm"
        href={href}
        external
      >
        {label}
      </Button>
    </div>
  );
}

/**
 * Per-row overflow menu (⋮): hides the row's session actions behind a discreet
 * button instead of a red "Quitar de la lista" shouting on every row (UX
 * 2026-08-18). Shows exactly ONE action per row, mutually exclusive by source:
 *  - app sessions   → "Editar / cancelar" (the edit screen)
 *  - external/manual → "Quitar de la lista" (dismissMatchedSession — a two-step
 *    confirm so a mis-tap can't remove a real session)
 * Renders nothing when there's no next session (no action applies).
 */
function RowMenu({
  sessionId,
  source,
}: {
  sessionId: string;
  source: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isApp = source === "app";
  const ref = useRef<HTMLDivElement>(null);

  // Close on a click outside or Escape — otherwise opening a second menu would
  // leave the first one open.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function doRemove() {
    setBusy(true);
    setError(null);
    const res = await dismissMatchedSession({ sessionId });
    setBusy(false);
    if ("error" in res) {
      setError(res.error);
      setConfirming(false);
    }
    // On success the revalidate re-renders the agenda without this row.
  }

  return (
    <div ref={ref} style={{ position: "relative", marginTop: 2 }}>
      <Button
        variant="neutral"
        size="sm"
        aria-label="Acciones de la sesión"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setConfirming(false);
          setError(null);
        }}
      >
        ⋮
      </Button>
      {open ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: "100%",
            marginTop: 4,
            background: "#fff",
            border: "1px solid #e6e2da",
            borderRadius: 10,
            boxShadow: "0 6px 20px rgba(0,0,0,0.12)",
            padding: 6,
            width: 190,
            zIndex: 20,
          }}
        >
          {isApp ? (
            <Button
              variant="ghost"
              size="sm"
              block
              role="menuitem"
              href={`/nueva-sesion/${sessionId}/editar`}
            >
              ✏️ Editar / cancelar
            </Button>
          ) : error ? (
            <div style={{ padding: "8px 10px", fontSize: 12.5, color: "#a02525" }}>
              {error}
            </div>
          ) : confirming ? (
            <div style={{ padding: "8px 10px" }}>
              <div style={{ fontSize: 13, color: "#555", marginBottom: 8 }}>
                ¿Quitar de la lista?
              </div>
              <div style={{ display: "flex", gap: 14 }}>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={doRemove}
                  disabled={busy}
                >
                  {busy ? "Quitando…" : "Sí, quitar"}
                </Button>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                >
                  No
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="dangerGhost"
              size="sm"
              block
              role="menuitem"
              onClick={() => setConfirming(true)}
            >
              🗑 Quitar de la lista
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Row({ r, rebookMode }: { r: ClientStatusRow; rebookMode: boolean }) {
  return (
    <tr>
      <td style={{ padding: "10px 8px", verticalAlign: "top", overflowWrap: "break-word" }}>
        <div style={{ fontWeight: 600 }}>{r.full_name}</div>
        <div style={{ color: "#777", fontSize: 12.5 }}>
          {r.phone}
          {r.opted_out ? " · no molestar" : ""}
        </div>
      </td>
      <td style={{ padding: "10px 8px", verticalAlign: "top" }}>
        <Badge kind={sessionBadge(r)} />
        {r.next_session_at ? (
          <div style={{ color: "#777", fontSize: 12.5, marginTop: 4 }}>
            {/* Time only — the date lives in the day header (issue #97). */}
            {formatTimeOnly(r.next_session_at)}
          </div>
        ) : null}
        {/* Rebooking signal (issue #92): only rendered when a later-day
            booking exists — its ABSENCE is the cue to offer a date at
            the desk. */}
        {nextAgainLabel(r) ? (
          <div style={{ color: "#9a9a9a", fontSize: 11.5, marginTop: 2 }}>
            luego: {nextAgainLabel(r)}
          </div>
        ) : null}
        {/* 🔁 quick action (issue #62): opens the OPERATOR's own WhatsApp
            (the shop's human number) with the message prefilled — same
            wa.me pattern as Reactivación. */}
        {sessionBadge(r) === "reschedule" && r.phone && r.next_session_at ? (
          <WaAction href={reschedWaLink(r.phone, r.full_name, r.next_session_at)} />
        ) : null}
        {/* Retention follow-up (issue #107): in the "sin re-reservar"
            worklist, offer a date from her last visit. Only when that
            worklist is active, so the button doesn't clutter every
            no-next row. */}
        {rebookMode && r.phone && !r.next_session_at ? (
          <WaAction
            href={rebookWaLink(r.phone, r.full_name)}
            label="Ofrecer fecha 📲"
          />
        ) : null}
      </td>
      <td
        style={{
          padding: "10px 8px",
          verticalAlign: "top",
          color: "#555",
          fontSize: 12.5,
          overflowWrap: "break-word",
        }}
      >
        {r.last_session_at ? (
          <>
            {formatWhen(r.last_session_at)}
            {r.last_service ? <div>{r.last_service}</div> : null}
          </>
        ) : (
          "—"
        )}
      </td>
      {/* Actions column (2026-08-19): the row's session actions (editar/
          cancelar for app rows, quitar for external/manual) live behind a ⋮
          at the FAR RIGHT of the row, where actions are expected — not tucked
          beside the status badge. Only when there's a next session with a
          known source. */}
      <td style={{ padding: "10px 4px", verticalAlign: "top", textAlign: "right" }}>
        {r.next_session_id && r.next_source ? (
          <RowMenu sessionId={r.next_session_id} source={r.next_source} />
        ) : null}
      </td>
    </tr>
  );
}

export default function ClientTable({
  rows,
  ghosts,
  nowMs,
  rebookMode = false,
}: {
  rows: ClientStatusRow[];
  /** Upcoming unidentified sessions to interleave (issue #99). */
  ghosts: GhostSession[];
  /** Server clock at render — day labels must not shift on hydration. */
  nowMs: number;
  /** The "sin re-reservar" worklist is active — show the offer-date action (issue #107). */
  rebookMode?: boolean;
}) {
  const [query, setQuery] = useState("");
  const visible = rows.filter((r) => matchesQuery(r, query));
  const visibleGhosts = ghosts.filter((g) => ghostMatchesQuery(g, query));
  const groups = groupAgendaByDay(visible, visibleGhosts, nowMs);

  return (
    <>
      {/* Row dividers live in CSS (not inline) so the LAST row in each day card
          can drop its border where it meets the rounded card edge. The first /
          last rows round their outer corners so a tinted row (ghost) doesn't
          poke past the card's radius now that overflow is visible. */}
      <style>{`
        .day-table tbody tr { border-bottom: 1px solid #f0f0f0; }
        .day-table tbody tr:last-child { border-bottom: none; }
        .day-table tbody tr:first-child td:first-child { border-top-left-radius: 13px; }
        .day-table tbody tr:first-child td:last-child { border-top-right-radius: 13px; }
        .day-table tbody tr:last-child td:first-child { border-bottom-left-radius: 13px; }
        .day-table tbody tr:last-child td:last-child { border-bottom-right-radius: 13px; }
      `}</style>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar por nombre o teléfono"
        aria-label="Buscar por nombre o teléfono"
        style={{
          width: "100%",
          minHeight: CONTROL_H,
          fontSize: 16,
          padding: "0 12px",
          borderRadius: 8,
          border: "1px solid #ccc",
          boxSizing: "border-box",
          marginBottom: 8,
        }}
      />

      <p style={{ fontSize: 13, color: "#777", margin: "0 0 8px" }}>
        {visible.length} {visible.length === 1 ? "clienta" : "clientas"}
        {visibleGhosts.length > 0
          ? ` · ${visibleGhosts.length} sin identificar`
          : ""}
      </p>

      {visible.length + visibleGhosts.length > 0 ? (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 14,
            tableLayout: "fixed",
          }}
        >
          {COLS}
          <thead>
            <tr style={{ textAlign: "left", color: "#555" }}>
              <th style={{ padding: "8px 8px" }}>Clienta</th>
              <th style={{ padding: "8px 8px" }}>Próxima</th>
              <th style={{ padding: "8px 8px" }}>Última</th>
              <th style={{ padding: "8px 8px" }} aria-label="Acciones" />
            </tr>
          </thead>
        </table>
      ) : null}

      {groups.map((g) => {
        const today = isTodayGroup(g);
        return (
          <section key={g.key} style={{ marginBottom: 18 }}>
            <GroupHeader group={g} />
            {/* Each day is its own card (2026-08-27 redesign) so days read as
                separate blocks; today's card is tinted with the accent border.
                overflow is VISIBLE (not hidden) so the last row's ⋮ menu can
                open past the card edge without being clipped — the first/last
                rows round their own corners instead (see the .day-table CSS). */}
            <div
              style={{
                background: "#fff",
                border: `1px solid ${today ? ACCENT : BORDER}`,
                borderRadius: 14,
                boxShadow: today
                  ? "0 1px 2px rgba(28,92,171,0.10), 0 8px 24px rgba(28,92,171,0.12)"
                  : "0 1px 2px rgba(0,0,0,0.04), 0 8px 22px rgba(0,0,0,0.05)",
              }}
            >
              <table
                className="day-table"
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 14,
                  tableLayout: "fixed",
                }}
              >
                {COLS}
                <tbody>
                  {g.items.map((i) =>
                    i.kind === "client"
                      ? <Row key={i.row.id} r={i.row} rebookMode={rebookMode} />
                      : <GhostRow key={`ghost-${i.ghost.id}`} g={i.ghost} />
                  )}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      {visible.length + visibleGhosts.length === 0 ? (
        <p style={{ padding: "16px 8px", color: "#777", margin: 0 }}>
          No hay clientas que coincidan.
        </p>
      ) : null}
    </>
  );
}

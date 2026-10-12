import { describe, expect, it } from "vitest";
import {
  askedToReschedule,
  BADGE_LABEL,
  dayGroupLabel,
  formatTimeOnly,
  ghostIsTomorrow,
  ghostMatchesQuery,
  type GhostSession,
  needsRebookFollowup,
  type PastSession,
  rebookingRate,
  groupAgendaByDay,
  nextAgainLabel,
  type ClientStatusRow,
  formatWhen,
  health,
  type JobRun,
  matchesQuery,
  operationalCompare,
  pendingConfirmTomorrow,
  sessionBadge,
} from "./status";

function row(over: Partial<ClientStatusRow> = {}): ClientStatusRow {
  return {
    id: "c1",
    full_name: "Ana Pérez",
    phone: "+59891234567",
    opted_out: false,
    last_session_at: "2026-07-01T14:00:00Z",
    last_service: "maderoterapia",
    next_session_at: "2026-07-25T14:00:00Z",
    next_session_id: "s1",
    next_status: "scheduled",
    next_confirmed_at: null,
    days_since_last: 10,
    next_source: "manual",
    next_external_covered: false,
    next2_session_at: null,
    ...over,
  };
}

describe("matchesQuery", () => {
  it("matches by partial name, accent- and case-insensitive", () => {
    expect(matchesQuery(row(), "ana")).toBe(true);
    expect(matchesQuery(row(), "PEREZ")).toBe(true); // no accent, upper
    expect(matchesQuery(row(), "  pér ")).toBe(true);
    expect(matchesQuery(row(), "otra")).toBe(false);
  });

  it("matches by partial phone digits", () => {
    expect(matchesQuery(row(), "091234567")).toBe(true); // last national digits
    expect(matchesQuery(row(), "1234")).toBe(true);
    expect(matchesQuery(row(), "+598")).toBe(true);
    expect(matchesQuery(row(), "9999")).toBe(false);
  });

  it("a lone '0' does not match everyone (leading-zero guard)", () => {
    expect(matchesQuery(row({ full_name: "Zoe" }), "0")).toBe(false);
  });

  it("empty query matches everyone", () => {
    expect(matchesQuery(row(), "")).toBe(true);
    expect(matchesQuery(row(), "   ")).toBe(true);
  });
});

describe("sessionBadge", () => {
  it("confirmed when the next session has confirmed_at", () => {
    expect(sessionBadge(row({ next_confirmed_at: "2026-07-20T10:00:00Z" }))).toBe(
      "confirmed",
    );
  });

  it("pending when there is a next session but no confirmation", () => {
    expect(sessionBadge(row())).toBe("pending");
  });

  it("reschedule when the next status is reschedule_requested", () => {
    expect(sessionBadge(row({ next_status: "reschedule_requested" }))).toBe(
      "reschedule",
    );
  });

  it("none when there is no upcoming session", () => {
    expect(
      sessionBadge(row({ next_session_at: null, next_session_id: null, next_status: null })),
    ).toBe("none");
  });

  it("askedToReschedule tracks the reschedule badge", () => {
    expect(askedToReschedule(row({ next_status: "reschedule_requested" }))).toBe(true);
    expect(askedToReschedule(row())).toBe(false);
  });
});

describe("health", () => {
  // "Now" 30 minutes after the last OK sync run.
  const NOW = new Date("2026-07-17T11:30:00Z").getTime();
  const runs: JobRun[] = [
    { job: "sync-calendar", ok: true, finished_at: "2026-07-17T10:00:00Z" },
    { job: "sync-calendar", ok: true, finished_at: "2026-07-17T11:00:00Z" },
    { job: "sync-calendar", ok: false, finished_at: "2026-07-17T12:00:00Z" },
    { job: "send-reminders", ok: null, finished_at: null },
  ];

  it("returns the newest OK finish time per job (ignores failed runs)", () => {
    const sync = health(runs, NOW).find((e) => e.job === "sync-calendar")!;
    expect(sync.finished_at).toBe("2026-07-17T11:00:00Z"); // latest OK, not the failed 12:00
    expect(sync.state).toBe("ok");
  });

  it("a job with no successful run is 'never' — even with zero rows", () => {
    const send = health(runs, NOW).find((e) => e.job === "send-reminders")!;
    expect(send.state).toBe("never");
    expect(send.finished_at).toBeNull();
  });

  it("ALWAYS lists both expected jobs, even on empty input", () => {
    expect(health([], NOW).map((e) => e.job)).toEqual([
      "sync-calendar",
      "send-reminders",
    ]);
    expect(health([], NOW).every((e) => e.state === "never")).toBe(true);
  });

  it("marks a sync older than 2h as stale, a reminders run within 26h as ok", () => {
    const later = new Date("2026-07-17T14:00:00Z").getTime(); // 3h after last OK sync
    const withReminders: JobRun[] = [
      ...runs,
      { job: "send-reminders", ok: true, finished_at: "2026-07-17T13:00:00Z" },
    ];
    const h = health(withReminders, later);
    expect(h.find((e) => e.job === "sync-calendar")!.state).toBe("stale");
    expect(h.find((e) => e.job === "send-reminders")!.state).toBe("ok");
  });
});

describe("pendingConfirmTomorrow", () => {
  const NOW = new Date("2026-07-19T13:00:00Z").getTime();

  it("true for an unconfirmed session on the next Montevideo day (issue #78 window)", () => {
    expect(
      pendingConfirmTomorrow(row({ next_session_at: "2026-07-20T14:00:00Z" }), NOW),
    ).toBe(true);
    // Tomorrow EARLY morning — the case the old rolling window missed.
    expect(
      pendingConfirmTomorrow(row({ next_session_at: "2026-07-20T12:00:00Z" }), NOW),
    ).toBe(true);
  });

  it("false outside the window (today / day after tomorrow)", () => {
    expect(
      pendingConfirmTomorrow(row({ next_session_at: "2026-07-19T20:00:00Z" }), NOW),
    ).toBe(false);
    expect(
      pendingConfirmTomorrow(row({ next_session_at: "2026-07-21T14:00:00Z" }), NOW),
    ).toBe(false);
  });

  it("half-open bounds match FR-2 exactly: tomorrow 00:00 MVD in, day-after 00:00 out", () => {
    expect(
      pendingConfirmTomorrow(row({ next_session_at: "2026-07-20T03:00:00Z" }), NOW),
    ).toBe(true); // exactly tomorrow 00:00 Montevideo → included
    expect(
      pendingConfirmTomorrow(row({ next_session_at: "2026-07-21T03:00:00Z" }), NOW),
    ).toBe(false); // exactly day-after 00:00 Montevideo → excluded
  });

  it("external-covered session tomorrow is NOT in the chase list (issue #89)", () => {
    expect(
      pendingConfirmTomorrow(
        row({ next_session_at: "2026-07-20T14:00:00Z", next_external_covered: true }),
        NOW,
      ),
    ).toBe(false);
  });

  it("false when confirmed or asked to reschedule or no next", () => {
    expect(
      pendingConfirmTomorrow(
        row({
          next_session_at: "2026-07-20T14:00:00Z",
          next_confirmed_at: "2026-07-19T10:00:00Z",
        }),
        NOW,
      ),
    ).toBe(false);
    expect(
      pendingConfirmTomorrow(
        row({
          next_session_at: "2026-07-20T14:00:00Z",
          next_status: "reschedule_requested",
        }),
        NOW,
      ),
    ).toBe(false);
    expect(
      pendingConfirmTomorrow(
        row({ next_session_at: null, next_session_id: null, next_status: null }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("operationalCompare", () => {
  it("clients with an upcoming session come first, soonest first", () => {
    const soon = row({ full_name: "Zoe", next_session_at: "2026-07-20T10:00:00Z" });
    const later = row({ full_name: "Ana", next_session_at: "2026-07-22T10:00:00Z" });
    const none = row({
      full_name: "Bea",
      next_session_at: null,
      next_session_id: null,
      next_status: null,
    });
    const sorted = [none, later, soon].sort(operationalCompare);
    expect(sorted.map((r) => r.full_name)).toEqual(["Zoe", "Ana", "Bea"]);
  });

  it("clients without a session sort alphabetically", () => {
    const mk = (name: string) =>
      row({
        full_name: name,
        next_session_at: null,
        next_session_id: null,
        next_status: null,
      });
    const sorted = [mk("carla"), mk("Ana"), mk("Bea")].sort(operationalCompare);
    expect(sorted.map((r) => r.full_name)).toEqual(["Ana", "Bea", "carla"]);
  });
});

describe("formatWhen", () => {
  it("formats a timestamp in Montevideo time", () => {
    // 2026-07-17T17:30:00Z is 14:30 in Montevideo (UTC-3).
    expect(formatWhen("2026-07-17T17:30:00Z")).toBe("17/07 14:30");
  });

  it("returns 'sin datos' for null", () => {
    expect(formatWhen(null)).toBe("sin datos");
  });
});

describe("sessionBadge · External (issue #89)", () => {
  it("external-covered next session shows the External chip, not pendiente", () => {
    expect(sessionBadge(row({ next_external_covered: true }))).toBe("external");
    expect(
      sessionBadge(row({ next_source: "external", next_external_covered: true })),
    ).toBe("external");
  });

  it("a real confirmation wins over External coverage", () => {
    expect(
      sessionBadge(
        row({ next_external_covered: true, next_confirmed_at: "2026-07-24T10:00:00Z" }),
      ),
    ).toBe("confirmed");
  });

  it("a reschedule request wins over External coverage", () => {
    expect(
      sessionBadge(
        row({ next_external_covered: true, next_status: "reschedule_requested" }),
      ),
    ).toBe("reschedule");
  });

  it("null coverage (pre-migration rows) falls back to pendiente", () => {
    expect(sessionBadge(row({ next_external_covered: null }))).toBe("pending");
    // Before the migration runs, select("*") rows lack the column entirely.
    expect(
      sessionBadge(row({ next_external_covered: undefined as unknown as null })),
    ).toBe("pending");
  });

  it("label is the neutral chip text", () => {
    expect(BADGE_LABEL.external).toBe("External");
  });
});

describe("nextAgainLabel (issue #92)", () => {
  it("formats the later-day booking as weekday dd/mm in Montevideo", () => {
    // 2026-08-05T17:30Z = mié 05/08 14:30 in Montevideo.
    expect(nextAgainLabel(row({ next2_session_at: "2026-08-05T17:30:00Z" }))).toBe(
      "mié 05/08",
    );
  });

  it("crosses the UTC midnight boundary on the Montevideo side", () => {
    // 02:00Z on the 6th is still the 5th in Montevideo.
    expect(nextAgainLabel(row({ next2_session_at: "2026-08-06T02:00:00Z" }))).toBe(
      "mié 05/08",
    );
  });

  it("null when there is no later booking — the rebooking signal", () => {
    expect(nextAgainLabel(row())).toBeNull();
    expect(nextAgainLabel(row({ next2_session_at: null }))).toBeNull();
  });
});

describe("dayGroupLabel / formatTimeOnly (issue #97)", () => {
  // Monday 27/07 12:00 in Montevideo.
  const NOW = Date.parse("2026-07-27T15:00:00Z");

  it("labels today and tomorrow in desk vocabulary", () => {
    expect(dayGroupLabel("2026-07-27T20:00:00Z", NOW)).toBe("Hoy · lun 27/07");
    expect(dayGroupLabel("2026-07-28T12:00:00Z", NOW)).toBe("Mañana · mar 28/07");
    expect(dayGroupLabel("2026-07-29T12:00:00Z", NOW)).toBe("mié 29/07");
  });

  it("a UTC-rollover session labels under its Montevideo day", () => {
    // 02:00Z on the 28th is still Monday 23:00 in Montevideo.
    expect(dayGroupLabel("2026-07-28T02:00:00Z", NOW)).toBe("Hoy · lun 27/07");
  });

  it("formats time-only in Montevideo, zero-padded", () => {
    expect(formatTimeOnly("2026-07-28T12:00:00Z")).toBe("09:00");
    expect(formatTimeOnly("2026-07-28T02:05:00Z")).toBe("23:05");
  });
});

describe("groupAgendaByDay (issues #97/#99)", () => {
  const NOW = Date.parse("2026-07-27T15:00:00Z");
  const at = (id: string, iso: string | null) =>
    row({
      id,
      full_name: `C ${id}`,
      next_session_at: iso,
      next_session_id: iso ? `s-${id}` : null,
      next_status: iso ? "scheduled" : null,
    });
  const ghost = (id: string, iso: string, title = `evento ${id}`): GhostSession => ({
    id,
    raw_title: title,
    starts_at: iso,
  });

  it("splits consecutive Montevideo days and buckets no-next at the tail", () => {
    const groups = groupAgendaByDay(
      [
        at("a", "2026-07-28T12:00:00Z"),
        at("b", "2026-07-28T21:00:00Z"),
        at("c", "2026-07-29T12:00:00Z"),
        at("d", null),
        at("e", null),
      ],
      [],
      NOW,
    );
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ["Mañana · mar 28/07", 2],
      ["mié 29/07", 1],
      ["Sin próxima sesión", 2],
    ]);
  });

  it("interleaves ghosts chronologically and counts them separately (issue #99)", () => {
    const groups = groupAgendaByDay(
      [at("a", "2026-07-28T12:00:00Z"), at("b", "2026-07-28T21:00:00Z")],
      [ghost("g1", "2026-07-28T15:00:00Z")],
      NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].clients).toBe(2);
    expect(groups[0].ghosts).toBe(1);
    expect(
      groups[0].items.map((i) => (i.kind === "client" ? i.row.id : `g:${i.ghost.id}`)),
    ).toEqual(["a", "g:g1", "b"]);
  });

  it("at the same instant the client row renders before the ghost", () => {
    const groups = groupAgendaByDay(
      [at("a", "2026-07-28T12:00:00Z")],
      [ghost("g1", "2026-07-28T12:00:00Z")],
      NOW,
    );
    expect(groups[0].items.map((i) => i.kind)).toEqual(["client", "ghost"]);
  });

  it("a ghost-only day still renders its group (issue #99)", () => {
    const groups = groupAgendaByDay(
      [at("a", "2026-07-28T12:00:00Z")],
      [ghost("g1", "2026-07-29T12:00:00Z")],
      NOW,
    );
    expect(groups.map((g) => [g.label, g.clients, g.ghosts])).toEqual([
      ["Mañana · mar 28/07", 1, 0],
      ["mié 29/07", 0, 1],
    ]);
  });

  it("UTC-rollover rows and ghosts stay in their Montevideo day group", () => {
    const groups = groupAgendaByDay(
      [at("a", "2026-07-28T12:00:00Z")],
      [ghost("g1", "2026-07-29T02:30:00Z")], // 23:30 MVD on the 28th
      NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].ghosts).toBe(1);
  });

  it("empty input yields no groups", () => {
    expect(groupAgendaByDay([], [], NOW)).toEqual([]);
  });
});

describe("ghostMatchesQuery (issue #99)", () => {
  const g: GhostSession = {
    id: "g1",
    raw_title: "Valentina Píriz cc y ax",
    starts_at: "2026-07-28T12:00:00Z",
  };

  it("matches the raw title, accent- and case-insensitive", () => {
    expect(ghostMatchesQuery(g, "piriz")).toBe(true);
    expect(ghostMatchesQuery(g, "VALENTINA")).toBe(true);
    expect(ghostMatchesQuery(g, "otra")).toBe(false);
  });

  it("empty query matches", () => {
    expect(ghostMatchesQuery(g, "  ")).toBe(true);
  });
});

describe("ghostIsTomorrow (issue #101)", () => {
  // Monday 27/07 12:00 in Montevideo → tomorrow window is the 28th local.
  const NOW = Date.parse("2026-07-27T15:00:00Z");
  const g = (iso: string): GhostSession => ({ id: "g", raw_title: "x", starts_at: iso });

  it("true for a session on the next Montevideo day", () => {
    expect(ghostIsTomorrow(g("2026-07-28T12:00:00Z"), NOW)).toBe(true);
    // Early morning tomorrow — the case a rolling window would miss.
    expect(ghostIsTomorrow(g("2026-07-28T11:00:00Z"), NOW)).toBe(true);
  });

  it("false for today and for the day after tomorrow", () => {
    expect(ghostIsTomorrow(g("2026-07-27T20:00:00Z"), NOW)).toBe(false);
    expect(ghostIsTomorrow(g("2026-07-29T12:00:00Z"), NOW)).toBe(false);
  });

  it("half-open bounds: tomorrow 00:00 MVD in, day-after 00:00 out", () => {
    expect(ghostIsTomorrow(g("2026-07-28T03:00:00Z"), NOW)).toBe(true);
    expect(ghostIsTomorrow(g("2026-07-29T03:00:00Z"), NOW)).toBe(false);
  });
});

describe("needsRebookFollowup (issue #107)", () => {
  const r = (over: Partial<import("./status").ClientStatusRow>) =>
    row({ next_session_at: null, next_session_id: null, next_status: null, ...over });

  it("attended in the 3-21 day gap with no next → yes", () => {
    expect(needsRebookFollowup(r({ days_since_last: 5 }))).toBe(true);
    expect(needsRebookFollowup(r({ days_since_last: 3 }))).toBe(true); // grace floor
    expect(needsRebookFollowup(r({ days_since_last: 21 }))).toBe(true); // reactivation ceiling
  });

  it("too recent (inside grace) → no", () => {
    expect(needsRebookFollowup(r({ days_since_last: 2 }))).toBe(false);
  });

  it("already cold (>21 days, Reactivación's job) → no", () => {
    expect(needsRebookFollowup(r({ days_since_last: 30 }))).toBe(false);
  });

  it("already rebooked (has a next session) → no", () => {
    expect(
      needsRebookFollowup(row({ days_since_last: 5, next_session_at: "2026-08-01T14:00:00Z" })),
    ).toBe(false);
  });

  it("opted out or never attended → no", () => {
    expect(needsRebookFollowup(r({ days_since_last: 5, opted_out: true }))).toBe(false);
    expect(needsRebookFollowup(r({ days_since_last: null }))).toBe(false);
  });
});

describe("rebookingRate (issue #107)", () => {
  const NOW = Date.parse("2026-07-29T15:00:00Z");
  const p = (starts_at: string, has_later: boolean): PastSession => ({
    client_id: "c", starts_at, has_later,
  });

  it("rate is rebooked ÷ evaluable, grace window excluded", () => {
    const past = [
      p("2026-07-01T12:00:00Z", true),   // evaluable, rebooked
      p("2026-07-05T12:00:00Z", true),   // evaluable, rebooked
      p("2026-07-10T12:00:00Z", false),  // evaluable, not
      p("2026-07-28T12:00:00Z", false),  // inside 3-day grace → excluded
    ];
    const res = rebookingRate(past, NOW);
    expect(res.evaluable).toBe(3);
    expect(res.rebooked).toBe(2);
    expect(res.rate).toBeCloseTo(2 / 3);
  });

  it("null rate when nothing is evaluable", () => {
    expect(rebookingRate([p("2026-07-29T12:00:00Z", false)], NOW).rate).toBeNull();
    expect(rebookingRate([], NOW).rate).toBeNull();
  });
});

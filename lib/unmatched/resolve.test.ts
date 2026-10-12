import { describe, expect, it } from "vitest";
import {
  type AliasLite,
  aliasConflictsWith,
  aliasMatches,
  allCandidatesFor,
  candidatesFor,
  filterClientOptions,
  isUpcoming,
  externalPrefill,
  matchableText,
  nameCandidatesFor,
  newClientDecision,
  type PickableClient,
  retroactiveMatches,
  sessionTokens,
  titleMatchesQuery,
  type UnmatchedSession,
} from "./resolve";

function session(over: Partial<UnmatchedSession> = {}): UnmatchedSession {
  return {
    id: "s1",
    gcal_event_id: "evt-1",
    starts_at: "2026-07-25T14:00:00Z",
    service: null,
    raw_title: "Ana Motta",
    raw_description: null,
    source: "manual",
    ...over,
  };
}

describe("matchableText / sessionTokens", () => {
  it("strips the External prefix before tokenizing", () => {
    expect(matchableText("external", "External - Cita con Ana Motta")).toBe("Ana Motta");
    expect(sessionTokens(session({ source: "external", raw_title: "External - Cita con Ana Motta" })))
      .toEqual(["ana", "motta"]);
  });

  it("drops service stopwords and numbers", () => {
    // "masaje" is a stopword, "3/8" is numeric noise.
    expect(sessionTokens(session({ raw_title: "Ana Motta masaje 3/8" }))).toEqual([
      "ana",
      "motta",
    ]);
  });
});

describe("aliasMatches (§7.2 subset rule)", () => {
  it("matches when alias tokens ⊆ event tokens", () => {
    expect(aliasMatches(["ana", "motta"], ["ana", "motta", "lifting"])).toBe(true);
  });
  it("does not match a superset alias (no fuzzy)", () => {
    expect(aliasMatches(["ana", "motta"], ["ana"])).toBe(false);
  });
  it("empty alias never matches", () => {
    expect(aliasMatches([], ["ana"])).toBe(false);
  });
});

describe("candidatesFor (ambiguous suggestions on top)", () => {
  const aliases: AliasLite[] = [
    { client_id: "c1", alias_tokens: ["ana", "motta"] },
    { client_id: "c2", alias_tokens: ["ana"] }, // also matches "Ana Motta"
    { client_id: "c3", alias_tokens: ["bea", "diaz"] }, // does not
  ];

  it("returns every client whose alias is a subset, deduped and ordered", () => {
    expect(candidatesFor(session({ raw_title: "Ana Motta" }), aliases)).toEqual([
      "c1",
      "c2",
    ]);
  });

  it("returns none when no alias fits", () => {
    expect(candidatesFor(session({ raw_title: "Persona Nueva" }), aliases)).toEqual([]);
  });
});

describe("aliasConflictsWith (R1 — one alias can't point to two clients)", () => {
  it("conflicts when the alias already belongs to a different client", () => {
    expect(aliasConflictsWith("client-A", "client-B")).toBe(true);
  });
  it("no conflict when it belongs to the same client", () => {
    expect(aliasConflictsWith("client-A", "client-A")).toBe(false);
  });
  it("no conflict when the alias is unused", () => {
    expect(aliasConflictsWith(null, "client-A")).toBe(false);
  });
});

describe("newClientDecision (R2 — never rename an existing client)", () => {
  it("creates when the phone is free", () => {
    expect(newClientDecision(null, "Ana Nueva")).toBe("create");
  });
  it("reuses when the phone belongs to the same name", () => {
    expect(newClientDecision({ full_name: "Ana Pérez" }, "  ana pérez ")).toBe("reuse");
  });
  it("conflicts when the phone belongs to a different name", () => {
    expect(newClientDecision({ full_name: "María González" }, "Maria G")).toBe("conflict");
  });
});

describe("retroactiveMatches (§7.3 — the core AC)", () => {
  const queued: UnmatchedSession[] = [
    session({ id: "s1", raw_title: "Ana Motta" }),
    session({ id: "s2", raw_title: "Ana Motta lifting" }), // same alias, still queued
    session({ id: "s3", raw_title: "Otra Persona" }),
    session({ id: "s4", source: "external", raw_title: "External - Cita con Ana Motta" }),
  ];

  it("resolving one session's alias retro-matches other queued sessions with it", () => {
    // A human resolves s1 as "Ana Motta"; the learned alias ["ana","motta"]
    // must now also resolve s2 and s4, but not s3.
    expect(retroactiveMatches(["ana", "motta"], "s1", queued).sort()).toEqual([
      "s2",
      "s4",
    ]);
  });

  it("excludes the just-resolved session itself", () => {
    expect(retroactiveMatches(["ana", "motta"], "s1", queued)).not.toContain("s1");
  });

  it("an empty alias retro-matches nothing", () => {
    expect(retroactiveMatches([], "s1", queued)).toEqual([]);
  });

  it("a specific alias does not over-match a broader session", () => {
    // alias ["ana","motta","lifting"] only fits s2, not the plain "Ana Motta".
    expect(retroactiveMatches(["ana", "motta", "lifting"], "s2", queued)).toEqual([]);
  });
});

describe("filterClientOptions (issue #80)", () => {
  const c = (id: string, full_name: string, phone: string): PickableClient => ({
    id,
    full_name,
    phone,
  });
  // Invented people and phones with a real format.
  const ana = c("c1", "Ana Pérez", "+59891234567");
  const anahi = c("c2", "Anahí Motta", "+59899876543");
  const lucia = c("c3", "Lucía González", "+59894445555");

  it("empty query shows ONLY the suggested candidates", () => {
    const { visible, hidden } = filterClientOptions([anahi], [ana, anahi, lucia], "", 8);
    expect(visible).toEqual([anahi]);
    expect(hidden).toBe(0);
  });

  it("empty query with no candidates shows nothing (hint state)", () => {
    expect(filterClientOptions([], [ana, anahi, lucia], "", 8).visible).toEqual([]);
  });

  it("searches by name, accent- and case-insensitive", () => {
    const { visible } = filterClientOptions([], [ana, anahi, lucia], "GONZALEZ", 8);
    expect(visible).toEqual([lucia]);
  });

  it("searches by phone digits, tolerating the local leading 0", () => {
    expect(filterClientOptions([], [ana, anahi, lucia], "091234", 8).visible).toEqual([ana]);
    expect(filterClientOptions([], [ana, anahi, lucia], "4567", 8).visible).toEqual([ana]);
  });

  it("candidates rank first among matches and are never duplicated", () => {
    const { visible } = filterClientOptions([anahi], [ana, anahi, lucia], "an", 8);
    expect(visible).toEqual([anahi, ana]); // both match "an"; suggested first, once
  });

  it("a suggested candidate that does not match the typed query drops out", () => {
    const { visible } = filterClientOptions([anahi], [ana, anahi, lucia], "lucia", 8);
    expect(visible).toEqual([lucia]);
  });

  it("caps the list and reports how many were hidden", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      c(`m${i}`, `Ana Clon ${i}`, `+5989000000${i}`));
    const { visible, hidden } = filterClientOptions([], many, "ana", 8);
    expect(visible).toHaveLength(8);
    expect(hidden).toBe(4);
  });
});

describe("nameCandidatesFor / allCandidatesFor (issue #83)", () => {
  const clients = [
    { id: "c1", full_name: "Jimena Rosales" },
    { id: "c2", full_name: "Euge" }, // single token — must never suggest
    { id: "c3", full_name: "Ana Motta" },
  ];

  it("suggests the client whose full name is contained in the title", () => {
    expect(
      nameCandidatesFor(session({ raw_title: "JImena Rosales 3/8 pe cc y ax" }), clients),
    ).toEqual(["c1"]);
  });

  it("is accent- and case-insensitive via the shared tokenizer", () => {
    expect(
      nameCandidatesFor(session({ raw_title: "jimena rosaleS depi" }), clients),
    ).toEqual(["c1"]);
  });

  it("a lone first name never suggests (>=2 tokens required)", () => {
    expect(nameCandidatesFor(session({ raw_title: "euge " }), clients)).toEqual([]);
  });

  it("a name that collapses under stopwords never suggests (>=2 is post-tokenizer)", () => {
    // "manos" is a service stopword: "Maria Manos" tokenizes to ["maria"],
    // which must fall under the >=2 bar instead of matching every Maria.
    const tricky = [...clients, { id: "c9", full_name: "Maria Manos" }];
    expect(
      nameCandidatesFor(session({ raw_title: "Maria depilacion manos" }), tricky),
    ).toEqual([]);
  });

  it("partial name (missing surname token) does not suggest — no fuzzy", () => {
    expect(nameCandidatesFor(session({ raw_title: "Jimena depi" }), clients)).toEqual([]);
  });

  it("multiple full-name hits all suggest (human disambiguates)", () => {
    const twins = [...clients, { id: "c4", full_name: "Jimena Rosales Diaz" }];
    expect(
      nameCandidatesFor(session({ raw_title: "Jimena Rosales Diaz cc" }), twins).sort(),
    ).toEqual(["c1", "c4"]);
  });

  it("allCandidatesFor: aliases first, name hits after, deduped", () => {
    const aliases: AliasLite[] = [{ client_id: "c3", alias_tokens: ["ana", "motta"] }];
    // c3 hits via alias AND name; c1 via name only. Alias order wins, no dupes.
    expect(
      allCandidatesFor(
        session({ raw_title: "Ana Motta y Jimena Rosales" }),
        aliases,
        clients,
      ),
    ).toEqual(["c3", "c1"]);
  });
});

describe("isUpcoming (issue #95)", () => {
  const now = Date.parse("2026-07-27T15:00:00Z"); // 12:00 in Montevideo

  it("a session later today or tomorrow is upcoming", () => {
    expect(isUpcoming("2026-07-27T18:00:00Z", now)).toBe(true);
    expect(isUpcoming("2026-07-28T12:00:00Z", now)).toBe(true);
  });

  it("a session earlier today is backlog, not upcoming", () => {
    expect(isUpcoming("2026-07-27T12:00:00Z", now)).toBe(false);
  });

  it("this exact instant still counts as upcoming (>= compare)", () => {
    expect(isUpcoming("2026-07-27T15:00:00Z", now)).toBe(true);
  });
});

describe("titleMatchesQuery (issue #109)", () => {
  it("matches the raw title, accent- and case-insensitive", () => {
    expect(titleMatchesQuery("Mica 15:30 piernas", "mica")).toBe(true);
    expect(titleMatchesQuery("Valentina Píriz cc", "piriz")).toBe(true);
    expect(titleMatchesQuery("Mica 15:30 piernas", "PIERNAS")).toBe(true);
    expect(titleMatchesQuery("Mica 15:30 piernas", "otra")).toBe(false);
  });

  it("empty query matches everything", () => {
    expect(titleMatchesQuery("cualquier cosa", "")).toBe(true);
    expect(titleMatchesQuery("cualquier cosa", "   ")).toBe(true);
  });
});

describe("externalPrefill (issue #111)", () => {
  // All names and phones are invented (real-format), per the sensitive-data rule.
  it("extracts name + UY phone from a External title", () => {
    expect(
      externalPrefill("external", "External - Cita con Alba Inventada 59891234567"),
    ).toEqual({ name: "Alba Inventada", phone: "+59891234567" });
  });

  it("handles the doubled space some titles have", () => {
    expect(
      externalPrefill("external", "External - Cita con Bea Ficticia  59892223344"),
    ).toEqual({ name: "Bea Ficticia", phone: "+59892223344" });
  });

  it("rejects a non-Uruguayan number → null (no prefill)", () => {
    // 11 digits not 598-prefixed → not a valid UY number.
    expect(
      externalPrefill("external", "External - Cita con Cira Extranjera 12345678901"),
    ).toBeNull();
  });

  it("null when there is no phone at all", () => {
    expect(externalPrefill("external", "External - Cita con Dora Inventada")).toBeNull();
  });

  it("only applies to external sources", () => {
    expect(externalPrefill("manual", "Ana Motta 59891234567")).toBeNull();
  });

  it("null when the name would be empty (phone only)", () => {
    expect(externalPrefill("external", "External - Cita con 59891234567")).toBeNull();
  });

  it("strips residual service-code punctuation from the name", () => {
    expect(
      externalPrefill("external", "External - Cita con Emi Ficticia cc 3/8 59893334455"),
    ).toEqual({ name: "Emi Ficticia cc", phone: "+59893334455" });
  });
});

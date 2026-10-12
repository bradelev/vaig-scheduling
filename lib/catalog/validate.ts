/**
 * Pure validation + shaping for booking_services drafts (the Servicios panel).
 * Mirrors the DB CHECK constraints on the `booking_services` table so the UI
 * rejects a bad draft with a clear Spanish message BEFORE the insert/update
 * (a raw constraint violation would surface as an opaque Postgres error).
 * No I/O — unit-tested. See lib/booking/hours-rules.ts for the same pattern.
 */

export type ServiceDraft = {
  name: string; // trimmed, 1..120 chars
  category: string | null; // trimmed, 1..60 chars, empty -> null
  durationMin: number; // integer 5..480
  priceUyu: number | null; // null = "a consultar"; else integer 0..1_000_000
  packageSessions: number | null; // null = normal service; else integer 2..60
};

function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function validateServiceDraft(
  input: unknown,
): { ok: true; draft: ServiceDraft } | { error: string } {
  const raw = (input ?? {}) as Record<string, unknown>;

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length < 1) return { error: "El nombre no puede estar vacío." };
  if (name.length > 120) return { error: "El nombre es demasiado largo (máximo 120 caracteres)." };

  let category: string | null = null;
  if (typeof raw.category === "string") {
    const trimmed = raw.category.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > 60) return { error: "La categoría es demasiado larga (máximo 60 caracteres)." };
      category = trimmed;
    }
  }

  const durationRaw = toFiniteNumber(raw.durationMin);
  if (
    durationRaw === null ||
    !Number.isInteger(durationRaw) ||
    durationRaw < 5 ||
    durationRaw > 480
  ) {
    return { error: "La duración debe ser entre 5 y 480 minutos." };
  }
  const durationMin = durationRaw;

  let priceUyu: number | null = null;
  if (raw.priceUyu !== null && raw.priceUyu !== undefined && raw.priceUyu !== "") {
    const price = toFiniteNumber(raw.priceUyu);
    if (price === null || !Number.isInteger(price) || price < 0 || price > 1_000_000) {
      return { error: "El precio no es válido." };
    }
    priceUyu = price;
  }

  let packageSessions: number | null = null;
  if (
    raw.packageSessions !== null &&
    raw.packageSessions !== undefined &&
    raw.packageSessions !== ""
  ) {
    const sessions = toFiniteNumber(raw.packageSessions);
    if (sessions === null || !Number.isInteger(sessions) || sessions < 2 || sessions > 60) {
      return { error: "Una cuponera necesita entre 2 y 60 sesiones." };
    }
    packageSessions = sessions;
  }

  return {
    ok: true,
    draft: { name, category, durationMin, priceUyu, packageSessions },
  };
}

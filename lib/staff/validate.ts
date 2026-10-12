/**
 * Pure validation + shaping for staff drafts (the Profesionales panel) and
 * for the staff_services priority field. No I/O — unit-tested.
 */
import { normalizePhoneIntl } from "../clients/phone";

/**
 * Slug a staff member's display name into her id: lowercase, strip accents
 * (NFD + drop combining marks, same technique as
 * lib/booking/service-category.ts's normalize()), keep only [a-z0-9].
 * "María José" -> "mariajose". An empty/unsluggable name stays "".
 */
export function staffSlug(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export type StaffDraft = {
  name: string;
  phone: string | null;
  colorId: number | null;
};

export function validateStaffDraft(
  input: unknown,
): { ok: true; draft: StaffDraft } | { error: string } {
  const raw = (input ?? {}) as Record<string, unknown>;

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length < 1) return { error: "El nombre no puede estar vacío." };
  if (name.length > 60) return { error: "El nombre es demasiado largo (máximo 60 caracteres)." };

  let phone: string | null = null;
  if (typeof raw.phone === "string" && raw.phone.trim().length > 0) {
    const normalized = normalizePhoneIntl(raw.phone.trim());
    if (!normalized) return { error: "El teléfono no es válido (formato +598…)." };
    phone = normalized;
  }

  let colorId: number | null = null;
  if (raw.colorId !== null && raw.colorId !== undefined && raw.colorId !== "") {
    const n = Number(raw.colorId);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 11) {
      return { error: "El color no es válido." };
    }
    colorId = n;
  }

  return { ok: true, draft: { name, phone, colorId } };
}

export function validatePriority(
  input: unknown,
): { ok: true; priority: number } | { error: string } {
  const n = Number(input);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 999) {
    return { error: "La prioridad debe ser un número entre 1 y 999." };
  }
  return { ok: true, priority: n };
}

/** Google Calendar event colors (colorId 1..11), Spanish labels. */
export const CALENDAR_COLORS: { id: number; label: string; hex: string }[] = [
  { id: 1, label: "Lavanda", hex: "#7986cb" },
  { id: 2, label: "Salvia", hex: "#33b679" },
  { id: 3, label: "Uva", hex: "#8e24aa" },
  { id: 4, label: "Flamenco", hex: "#e67c73" },
  { id: 5, label: "Banana", hex: "#f6c026" },
  { id: 6, label: "Mandarina", hex: "#f5511d" },
  { id: 7, label: "Pavo real", hex: "#039be5" },
  { id: 8, label: "Grafito", hex: "#616161" },
  { id: 9, label: "Arándano", hex: "#3f51b5" },
  { id: 10, label: "Albahaca", hex: "#0b8043" },
  { id: 11, label: "Tomate", hex: "#d60000" },
];

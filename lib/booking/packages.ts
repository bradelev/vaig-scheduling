/**
 * Pure helpers for cuponeras (prepaid packages). No I/O — unit-tested.
 */

export type PackageBalance = {
  id: string;
  total: number;
  used: number;
};

/** Credits still available on a package. */
export function packageRemaining(p: { total: number; used: number }): number {
  return Math.max(0, p.total - p.used);
}

/** "te quedan 4 de 6" / "te queda 1 de 6" / "no te quedan sesiones de 6". Client copy. */
export function remainingLabel(p: { total: number; used: number }): string {
  const r = packageRemaining(p);
  if (r === 0) return `no te quedan sesiones de ${p.total}`;
  return `te ${r === 1 ? "queda" : "quedan"} ${r} de ${p.total}`;
}

/** True when a catalog item is a prepaid package. */
export function isPackageItem(packageSessions: number | null | undefined): packageSessions is number {
  return typeof packageSessions === "number" && packageSessions >= 2;
}

export type PackageStatus = "pendiente_pago" | "pagada" | "cancelada";

/** Staff-facing label for a package's payment state. */
export const PACKAGE_STATUS_LABEL: Record<PackageStatus, string> = {
  pendiente_pago: "Pendiente de pago",
  pagada: "Pagada",
  cancelada: "Cancelada",
};

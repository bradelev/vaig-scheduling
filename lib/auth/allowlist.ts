/**
 * STAFF_EMAILS allowlist (PRD FR-4, issue E3-T1).
 * Missing or empty env means an empty allowlist: nobody gets in.
 */

export function parseStaffEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

export function isStaffEmail(
  email: string | null | undefined,
  raw: string | undefined = process.env.STAFF_EMAILS,
): boolean {
  if (!email) return false;
  return parseStaffEmails(raw).has(email.trim().toLowerCase());
}

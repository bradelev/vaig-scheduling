/**
 * Pure seed planning (PRD FR-5, issue E1-T4): normalize + dedupe by phone,
 * split into upserts and rejects. No I/O so the dedup/reject rules are
 * unit-tested without a DB (seed.ts does the file read and upsert).
 */

export type Row = { name: string; phone: string; line: number };
export type Reject = { name: string; phone: string; reason: string };
export type SeedPlan = {
  toUpsert: { full_name: string; phone: string }[];
  rejects: Reject[];
};

/**
 * First valid occurrence of a phone wins. A later row with the same phone
 * but a different name is a reject (a human picks the right name); an
 * identical name+phone repeat is skipped silently (same client, multiple
 * service forms). Empty names and un-normalizable phones are rejects.
 */
export function planSeed(
  rows: Row[],
  normalizePhone: (s: string) => string | null,
): SeedPlan {
  const byPhone = new Map<string, { name: string }>();
  const rejects: Reject[] = [];
  const toUpsert: { full_name: string; phone: string }[] = [];

  for (const row of rows) {
    if (!row.name) {
      rejects.push({ name: row.name, phone: row.phone, reason: "empty name" });
      continue;
    }
    const phone = normalizePhone(row.phone);
    if (!phone) {
      rejects.push({ name: row.name, phone: row.phone, reason: "invalid phone" });
      continue;
    }
    const seen = byPhone.get(phone);
    if (!seen) {
      byPhone.set(phone, { name: row.name });
      toUpsert.push({ full_name: row.name, phone });
    } else if (seen.name.toLowerCase() !== row.name.toLowerCase()) {
      rejects.push({
        name: row.name,
        phone: row.phone,
        reason: `duplicate phone (kept "${seen.name}")`,
      });
    }
    // identical name+phone repeat → skipped, not a reject.
  }

  return { toUpsert, rejects };
}

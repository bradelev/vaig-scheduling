/// <reference lib="deno.ns" />
/**
 * seed.ts (PRD FR-5, issue E1-T4) — loads a `(name, phone)` CSV into the
 * clients table: normalize phones (§7.1), dedupe by phone, upsert by phone
 * (idempotent — safe to re-run), and write seed-rejects.csv with every
 * invalid or duplicate row for one-time manual correction.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     deno run --allow-read --allow-write --allow-env --allow-net \
 *     scripts/seed.ts vaig-data/clientes.csv
 *
 * PRIVACY: reads real client data. Prints only counts, never row content.
 * The rejects file stays local (vaig-data/ is gitignored); never commit it.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { normalizePhone } from "../lib/normalize.ts";
import { planSeed, type Reject, type Row } from "./seed-plan.ts";

/** Minimal CSV parser: quoted fields, "" escapes, commas/newlines in quotes. */
function parseCsv(text: string): Record<string, string>[] {
  const src = text.replace(/\r\n/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  while (rows.length && rows.at(-1)!.length === 1 && rows.at(-1)![0] === "") rows.pop();
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((values) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => (rec[h] = values[i] ?? ""));
    return rec;
  });
}

function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

async function main() {
  const csvPath = Deno.args[0];
  if (!csvPath) {
    console.error("usage: seed.ts <path-to-csv>  (columns: name,phone)");
    Deno.exit(1);
  }
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    Deno.exit(1);
  }

  const records = parseCsv(await Deno.readTextFile(csvPath));
  const rows: Row[] = records.map((r, i) => ({
    name: (r.name ?? "").trim(),
    phone: (r.phone ?? "").trim(),
    line: i + 2, // +1 header, +1 to 1-index
  }));

  // Normalize + dedupe by phone (§7.1). Pure — see seed-plan.ts.
  const { toUpsert, rejects } = planSeed(rows, normalizePhone);

  // Idempotent upsert by phone (unique). Chunk to keep requests small.
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const CHUNK = 500;
  let upserted = 0;
  for (let i = 0; i < toUpsert.length; i += CHUNK) {
    const chunk = toUpsert.slice(i, i + CHUNK);
    const { error } = await db
      .from("clients")
      .upsert(chunk, { onConflict: "phone", ignoreDuplicates: false });
    if (error) {
      console.error(`upsert failed at chunk ${i / CHUNK}: ${error.message}`);
      Deno.exit(1);
    }
    upserted += chunk.length;
  }

  // Write rejects next to the input for manual correction. Named exactly
  // seed-rejects.csv per PRD FR-5, in the same directory as the input CSV.
  const slash = csvPath.lastIndexOf("/");
  const dir = slash === -1 ? "." : csvPath.slice(0, slash);
  const rejectsPath = `${dir}/seed-rejects.csv`;
  const lines = ["name,phone,reason"];
  for (const r of rejects) {
    lines.push(`${csvField(r.name)},${csvField(r.phone)},${csvField(r.reason)}`);
  }
  await Deno.writeTextFile(rejectsPath, lines.join("\r\n") + "\r\n");

  console.log(`read:      ${rows.length} rows`);
  console.log(`upserted:  ${upserted} clients (deduped by phone)`);
  console.log(`rejected:  ${rejects.length} rows -> ${rejectsPath}`);
  const invalid = rejects.filter((r) => r.reason === "invalid phone").length;
  const dupes = rejects.filter((r) => r.reason.startsWith("duplicate")).length;
  const empty = rejects.filter((r) => r.reason === "empty name").length;
  console.log(`  invalid phone: ${invalid} · duplicates: ${dupes} · empty name: ${empty}`);
}

await main();

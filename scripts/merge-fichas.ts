/// <reference lib="deno.ns" />
/**
 * merge-fichas.ts (issue E1-T4) — unifies the four Google-Forms CSV exports
 * in vaig-data/ into a single vaig-data/clientes.csv with columns
 * `name,phone`. Run with `deno run --allow-read --allow-write`.
 *
 * PRIVACY: this reads real client data (names, phone numbers). Never print
 * row content, only per-file/total counts and the output path.
 */

const SOURCES = [
  {
    file: "Ficha de Servicios Faciales (Respuestas) - Respuestas de formulario 1.csv",
    name: "Nombre y Apellido",
    phone: "Celular",
  },
  {
    file: "Ficha personal de depilación (Respuestas) - Respuestas de formulario 1 (2).csv",
    name: "Nombre y Apellido",
    phone: "Celular",
  },
  {
    file: "Ficha personal de masajes (Respuestas) - Respuestas de formulario 1 (1).csv",
    name: "Nombre y Apellido",
    phone: "Celular",
  },
  {
    file: "Ficha personal para manos y pies (Respuestas) - Respuestas de formulario 1.csv",
    name: "nombre y apellido ",
    phone: "telefono ",
  },
];
const DATA_DIR = "vaig-data";
const OUT = "vaig-data/clientes.csv";

type ParsedCsv = { header: string[]; records: Record<string, string>[] };

/**
 * RFC-4180-ish CSV parser. Handles quoted fields (double-quotes), escaped
 * quotes (""), commas and newlines inside quoted fields, and CRLF/LF line
 * endings. Returns the header row plus an array of objects keyed by the
 * (untrimmed) header text, one per data row.
 */
function parseCsv(text: string): ParsedCsv {
  // Normalize CRLF to LF up front; quoted newlines are re-inserted as \n,
  // which is fine since we only care about field boundaries, not the
  // original line-ending bytes.
  const src = text.replace(/\r\n/g, "\n");

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = src.length;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // Flush trailing field/row if the file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  // Drop fully-empty trailing rows (e.g. a trailing blank line).
  while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }

  if (rows.length === 0) return { header: [], records: [] };
  const header = rows[0];
  const records: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const values = rows[r];
    const record: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      record[header[c]] = values[c] ?? "";
    }
    records.push(record);
  }
  return { header, records };
}

/**
 * Short label for a source file's log line, e.g. "faciales" or
 * "manos y pies". Derived mechanically from the "Ficha ... de/para X"
 * pattern in the filename, never from row content.
 */
function labelFor(file: string): string {
  const match = file.match(/Ficha (?:personal )?(?:de |para )?(.+?) \(Respuestas\)/i);
  return (match ? match[1] : file.replace(/\.csv$/i, "")).toLowerCase();
}

/** Quotes a CSV field if it contains a comma, quote, or newline. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function main() {
  const collected: { name: string; phone: string }[] = [];
  const counts: { label: string; count: number }[] = [];

  for (const source of SOURCES) {
    const path = `${DATA_DIR}/${source.file}`;
    const text = await Deno.readTextFile(path);
    const { header, records } = parseCsv(text);

    if (!header.includes(source.name)) {
      console.error(`Missing column "${source.name}" in file: ${source.file}`);
      Deno.exit(1);
    }
    if (!header.includes(source.phone)) {
      console.error(`Missing column "${source.phone}" in file: ${source.file}`);
      Deno.exit(1);
    }

    for (const record of records) {
      collected.push({
        name: (record[source.name] ?? "").trim(),
        phone: (record[source.phone] ?? "").trim(),
      });
    }

    counts.push({ label: labelFor(source.file), count: records.length });
  }

  const lines = ["name,phone"];
  for (const row of collected) {
    lines.push(`${csvField(row.name)},${csvField(row.phone)}`);
  }
  await Deno.writeTextFile(OUT, lines.join("\r\n") + "\r\n");

  for (const { label, count } of counts) {
    console.log(`${label}: ${count} rows`);
  }
  console.log(`TOTAL: ${collected.length} rows -> ${OUT}`);
}

await main();

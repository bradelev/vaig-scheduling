import { describe, expect, it } from "vitest";
import { normalizePhone } from "../lib/normalize";
import { planSeed, type Row } from "./seed-plan";

function rows(...entries: [string, string][]): Row[] {
  return entries.map(([name, phone], i) => ({ name, phone, line: i + 2 }));
}

describe("planSeed", () => {
  it("normalizes and upserts valid rows (invented data)", () => {
    const { toUpsert, rejects } = planSeed(
      rows(["Ana Gómez", "099111222"], ["Bea Díaz", "91234567"]),
      normalizePhone,
    );
    expect(rejects).toEqual([]);
    expect(toUpsert).toEqual([
      { full_name: "Ana Gómez", phone: "+59899111222" },
      { full_name: "Bea Díaz", phone: "+59891234567" }, // 8-digit → +598 9…
    ]);
  });

  it("dedupes an identical repeat silently (same client, many forms)", () => {
    const { toUpsert, rejects } = planSeed(
      rows(["Ana Gómez", "099111222"], ["ana gómez", "099 111 222"]),
      normalizePhone,
    );
    expect(toUpsert).toHaveLength(1);
    expect(rejects).toEqual([]); // case/format difference, same identity
  });

  it("rejects a same-phone different-name row, keeping the first", () => {
    const { toUpsert, rejects } = planSeed(
      rows(["Ana Gómez", "099111222"], ["Otra Persona", "099111222"]),
      normalizePhone,
    );
    expect(toUpsert).toEqual([{ full_name: "Ana Gómez", phone: "+59899111222" }]);
    expect(rejects).toHaveLength(1);
    expect(rejects[0].name).toBe("Otra Persona");
    expect(rejects[0].reason).toContain("duplicate phone");
    expect(rejects[0].reason).toContain("Ana Gómez");
  });

  it("rejects an un-normalizable phone", () => {
    const { toUpsert, rejects } = planSeed(
      rows(["Carla Ruiz", "12345"], ["Dana Sosa", "099 y 098 juntos 12345678901234"]),
      normalizePhone,
    );
    expect(toUpsert).toEqual([]);
    expect(rejects).toHaveLength(2);
    expect(rejects.every((r) => r.reason === "invalid phone")).toBe(true);
  });

  it("rejects an empty name", () => {
    const { toUpsert, rejects } = planSeed(rows(["", "099111222"]), normalizePhone);
    expect(toUpsert).toEqual([]);
    expect(rejects[0].reason).toBe("empty name");
  });

  it("is order-stable: first valid occurrence wins", () => {
    const { toUpsert } = planSeed(
      rows(
        ["Primera", "099111222"],
        ["Segunda", "099333444"],
        ["Duplicada", "099111222"],
      ),
      normalizePhone,
    );
    expect(toUpsert.map((c) => c.full_name)).toEqual(["Primera", "Segunda"]);
  });
});

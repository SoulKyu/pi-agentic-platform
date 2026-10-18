import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ADR_DIR = fileURLToPath(new URL("../docs/adr/", import.meta.url));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Adr {
  file: string;
  number: number;
  status: string;
  date: string | null;
  text: string;
}
interface Row {
  number: number;
  cells: string[];
}

function readAdrs(): Adr[] {
  return readdirSync(ADR_DIR)
    .filter((f) => /^\d{4}-.+\.md$/.test(f))
    .sort()
    .map((file) => {
      const text = readFileSync(join(ADR_DIR, file), "utf8");
      const lines = text.split("\n");
      const statusLine = lines.slice(0, 6).find((l) => l.startsWith("Status:")) ?? "";
      const date =
        lines
          .slice(0, 6)
          .join("\n")
          .match(/Date: (\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
      return { file, number: Number(file.slice(0, 4)), status: statusLine, date, text };
    });
}

function readRows(): Row[] {
  const readme = readFileSync(join(ADR_DIR, "README.md"), "utf8");
  return readme
    .split("\n")
    .filter((l) => /^\| \d{4} \|/.test(l))
    .map((l) => {
      const cells = l
        .replace(/^\||\|$/g, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.trim());
      return { number: Number(cells[0]), cells };
    });
}

describe("ADR index", () => {
  const adrs = readAdrs();
  const max = Math.max(...adrs.map((a) => a.number));

  it("every ADR has a Status line that starts with accepted or superseded by NNNN", () => {
    for (const adr of adrs) {
      expect(adr.status, adr.file).toMatch(/^Status: (accepted|superseded by \d{4})/);
    }
  });

  it("an ADR whose text says superseded has a superseded by status", () => {
    for (const adr of adrs) {
      if (/\bsuperseded\b/i.test(adr.text)) {
        expect(adr.status, adr.file).toMatch(/^Status: superseded by \d{4}/);
      }
    }
  });

  it("the README has one row per ADR file with its status and date", () => {
    const rows = readRows();
    for (const adr of adrs) {
      const matching = rows.filter((r) => r.number === adr.number);
      expect(matching, adr.file).toHaveLength(1);
      const [, title, status, date] = matching[0]?.cells ?? [];
      expect(title, adr.file).toContain(`(${adr.file})`);
      const kind = adr.status.startsWith("Status: superseded") ? "superseded" : "accepted";
      expect(status, adr.file).toMatch(new RegExp(`^${kind}`));
      expect(date, adr.file).toMatch(ISO_DATE);
      if (adr.date !== null) expect(date, adr.file).toBe(adr.date);
    }
  });

  it("every number below the highest is a file or a not used row", () => {
    const rows = readRows();
    const files = new Set(adrs.map((a) => a.number));
    for (let n = 1; n <= max; n++) {
      const matching = rows.filter((r) => r.number === n);
      expect(matching, String(n)).toHaveLength(1);
      expect(matching[0]?.cells[1] === "not used", String(n)).toBe(!files.has(n));
    }
    expect(rows.filter((r) => r.number > max)).toEqual([]);
  });

  it("prints the next free number as max + 1", () => {
    const readme = readFileSync(join(ADR_DIR, "README.md"), "utf8");
    const printed = readme.match(/^Next free number: (\d{4})$/m)?.[1];
    expect(printed).toBe(String(max + 1).padStart(4, "0"));
  });
});

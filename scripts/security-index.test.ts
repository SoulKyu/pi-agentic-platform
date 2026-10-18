import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const POLICY = "docs/agents/policy.md";
const HEADING = "## Security tests";

/** The ten items of spec C section 8.1, by the names the index rows carry. */
const SPEC_ITEMS = [
  "traversal /files",
  "traversal static",
  "webhook bad secret",
  "webhook bad hmac",
  "webhook 64KB+1",
  "webhook dedup replay",
  "fail-closed rules",
  "fail-closed exceptions",
  "taint then exfiltration",
  "forged origin",
] as const;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Whether `title` is the first argument of an `it(`, `describe(` or `it.each(...)(` call in `source`. */
const hasTitle = (source: string, title: string): boolean =>
  new RegExp(
    `\\b(?:it|describe)(?:\\.each\\((?:[^()]|\\([^()]*\\))*\\))?\\(\\s*${escapeRegExp(JSON.stringify(title))}`,
  ).test(source);

/** The problems of the "Security tests" section in `text`; empty when every row is real. `readFile` throws for a missing path. */
export function checkIndex(text: string, readFile: (path: string) => string): string[] {
  const start = text.indexOf(`\n${HEADING}\n`);
  if (start < 0) return [`the section "${HEADING}" is missing`];
  const body = text.slice(start + HEADING.length + 2).split(/\n## /)[0] ?? "";
  const rows = body.split("\n").flatMap((line) => {
    const match = /^- ([^|`]+?) \| (\S+) \| (.+)$/.exec(line);
    return match ? [{ item: match[1] ?? "", path: match[2] ?? "", title: match[3] ?? "" }] : [];
  });
  const problems: string[] = [];
  for (const name of SPEC_ITEMS) {
    if (!rows.some((row) => row.item === name)) problems.push(`no row for "${name}"`);
  }
  for (const row of rows) {
    let source: string;
    try {
      source = readFile(row.path);
    } catch {
      problems.push(`${row.item}: ${row.path} does not exist`);
      continue;
    }
    if (!hasTitle(source, row.title))
      problems.push(`${row.item}: "${row.title}" is not a test title in ${row.path}`);
  }
  return problems;
}

const readRepo = (path: string): string => readFileSync(join(REPO, path), "utf8");

describe("security-test index (spec C section 8.1)", () => {
  const policy = readRepo(POLICY);

  it("lists the ten spec items, and every row names a file and a test title that exist", () => {
    expect(checkIndex(policy, readRepo)).toEqual([]);
  });

  it("fails on a renamed title, a missing file and a dropped spec item", () => {
    const renamed = policy.replace("answers a bad secret 401", "answers a bad secret 402");
    expect(checkIndex(renamed, readRepo)).toEqual([
      expect.stringContaining('webhook bad secret: "answers a bad secret 402'),
    ]);
    const moved = policy.replace("security/webhook.int.test.ts", "security/webhook-gone.int.test.ts");
    expect(checkIndex(moved, readRepo).some((problem) => problem.includes("does not exist"))).toBe(true);
    const dropped = policy
      .split("\n")
      .filter((line) => !line.startsWith("- forged origin | "))
      .join("\n");
    expect(checkIndex(dropped, readRepo)).toEqual(['no row for "forged origin"']);
  });

  it("fails when the section is absent", () => {
    expect(checkIndex("# Policy\n", readRepo)).toEqual([`the section "${HEADING}" is missing`]);
  });
});

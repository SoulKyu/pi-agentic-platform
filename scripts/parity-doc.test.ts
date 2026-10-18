import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Parity audit (M13R20, M13R30): every pi-web feature of docs/research/pi-web-inventory.md, the additions of spec A
 * section 5.2 and the items kept by spec C section 7.3 has a row `| P<dd>-<n> | behaviour | proof | verdict |` whose proof
 * is a test file, an e2e journey or a smoke script that exists. The rows of D07 to D10 live in docs/agents/models.md.
 */

interface Row {
  source: string;
  id: string;
  domain: number;
  behaviour: string;
  proof: string;
  verdict: string;
  text: string;
}
interface Finding {
  row: string;
  rule: "shape" | "domain" | "duplicate" | "proof" | "verdict" | "gap" | "reference";
  detail: string;
}
interface Context {
  /** Strict resolution: a full repository path that exists. */
  exists(path: string): boolean;
  /** Loose resolution for the older models.md block, which abbreviates paths with `...` or leaves out the root. */
  resolveLoose(token: string): boolean;
  /** Does a ruling `M<n>R<n>` appear in the rulings, plans or research notes? */
  hasRuling(ruling: string): boolean;
  /** Does the decisions log hold this decision number? */
  hasDecision(n: string): boolean;
}

const ROW = /^\|\s*(P(\d\d)-\d+)\s*\|(.+)\|\s*$/;
const VERDICT = /^(green|dropped \(owner [^)]+\)|after v1 \([^)]+\))( \([^)]+\))?$/;
const GREEN = /^green( \([^)]+\))?$/;
const RULING = /\bM\d+R\d+\b/g;
const DECISION = /\bdecision (\d+)\b/gi;
const FILE_LIKE = /\.(ts|tsx|js|mjs|json|md|sh)$/;
const DOMAINS = Array.from({ length: 22 }, (_, i) => i + 1);

function parseRows(source: string, text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    const m = ROW.exec(line);
    if (!m) continue;
    const cells = (m[3] as string).split(" | ").map((c) => c.trim());
    if (cells.length < 3) {
      rows.push({
        source,
        id: m[1] as string,
        domain: Number(m[2]),
        behaviour: "",
        proof: "",
        verdict: "",
        text: line,
      });
      continue;
    }
    const verdict = cells[cells.length - 1] as string;
    const proof = cells[cells.length - 2] as string;
    const behaviour = cells.slice(0, cells.length - 2).join(" | ");
    rows.push({ source, id: m[1] as string, domain: Number(m[2]), behaviour, proof, verdict, text: line });
  }
  return rows;
}

function backticked(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
}

function checkRows(rows: Row[], ctx: Context, strict: boolean): Finding[] {
  const out: Finding[] = [];
  const add = (row: string, rule: Finding["rule"], detail: string) => out.push({ row, rule, detail });
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) add(row.id, "duplicate", row.source);
    seen.add(row.id);
    if (!row.verdict) {
      add(row.id, "shape", "a row has a behaviour, a proof and a verdict");
      continue;
    }
    if (/\bgap\b/i.test(row.verdict)) add(row.id, "gap", row.verdict);
    else if (!VERDICT.test(row.verdict) || (row.verdict.startsWith("green") && !GREEN.test(row.verdict))) {
      add(row.id, "verdict", row.verdict);
    }
    const all = backticked(row.proof);
    const tokens = strict ? all : all.filter((token) => FILE_LIKE.test(token));
    if (tokens.length === 0 && (strict || !row.verdict.startsWith("dropped")))
      add(row.id, "proof", "no file named");
    for (const token of tokens) {
      if (strict) {
        if (/…|\.\.\./.test(token)) add(row.id, "proof", `abbreviated path ${token}`);
        else if (!ctx.exists(token)) add(row.id, "proof", `no such file ${token}`);
      } else if (!ctx.resolveLoose(token)) add(row.id, "proof", `no such file ${token}`);
    }
    if (VERDICT.test(row.verdict) && !row.verdict.startsWith("green")) {
      const rulings = row.text.match(RULING) ?? [];
      const decisions = [...row.text.matchAll(DECISION)].map((m) => m[1] as string);
      if (rulings.length + decisions.length === 0) add(row.id, "reference", "names no ruling or decision");
      for (const ruling of rulings) if (!ctx.hasRuling(ruling)) add(row.id, "reference", `unknown ${ruling}`);
      for (const n of decisions) if (!ctx.hasDecision(n)) add(row.id, "reference", `unknown decision ${n}`);
    }
  }
  for (const d of DOMAINS) {
    if (!rows.some((r) => r.domain === d)) add(`D${String(d).padStart(2, "0")}`, "domain", "no row");
  }
  return out;
}

const fix: Context = {
  exists: (p) => p === "a/b.test.ts",
  resolveLoose: (t) => t === "b.test.ts" || t === "a/b.test.ts",
  hasRuling: (r) => r === "M13R20",
  hasDecision: (n) => n === "73",
};
function allDomains(extra: string): string {
  const lines = DOMAINS.map((d) => `| P${String(d).padStart(2, "0")}-1 | thing | \`a/b.test.ts\` | green |`);
  return [...lines, extra].join("\n");
}
function findings(extra: string, strict = true): string[] {
  const rows = parseRows("fixture", allDomains(extra));
  return checkRows(rows, fix, strict).map((f) => `${f.row}:${f.rule}`);
}

describe("the parity checker on fixtures", () => {
  it("accepts a table with every domain, existing proofs and a known verdict", () => {
    expect(findings("")).toEqual([]);
  });
  it("names a domain with no row", () => {
    const rows = parseRows("fixture", allDomains("").split("\n").slice(1).join("\n"));
    expect(checkRows(rows, fix, true).map((f) => `${f.row}:${f.rule}`)).toEqual(["D01:domain"]);
  });
  it("refuses a missing proof file, an abbreviated path and a row with no file", () => {
    expect(findings("| P03-2 | x | `a/gone.test.ts` | green |")).toEqual(["P03-2:proof"]);
    expect(findings("| P03-2 | x | `a/.../b.test.ts` | green |")).toEqual(["P03-2:proof"]);
    expect(findings("| P03-2 | x | the tests | green |")).toEqual(["P03-2:proof"]);
  });
  it("refuses a gap and an unknown verdict", () => {
    expect(findings("| P03-2 | x | `a/b.test.ts` | gap |")).toEqual(["P03-2:gap"]);
    expect(findings("| P03-2 | x | `a/b.test.ts` | gap (finding) |")).toEqual(["P03-2:gap"]);
    expect(findings("| P03-2 | x | `a/b.test.ts` | maybe |")).toEqual(["P03-2:verdict"]);
    expect(findings("| P03-2 | x | `a/b.test.ts` | green or so |")).toEqual(["P03-2:verdict"]);
  });
  it("wants a ruling that exists behind a dropped or an after v1 verdict", () => {
    expect(findings("| P03-2 | x | `a/b.test.ts` | dropped (owner m10, M13R20) |")).toEqual([]);
    expect(findings("| P03-2 | x | `a/b.test.ts` | after v1 (owner q6, M13R20) |")).toEqual([]);
    expect(findings("| P03-2 | x | `a/b.test.ts` | after v1 (decision 73) |")).toEqual([]);
    expect(findings("| P03-2 | x | `a/b.test.ts` | after v1 (owner q6) |")).toEqual(["P03-2:reference"]);
    expect(findings("| P03-2 | x | `a/b.test.ts` | after v1 (M13R99) |")).toEqual(["P03-2:reference"]);
    expect(findings("| P03-2 | x | `a/b.test.ts` | dropped (owner m10, decision 5) |")).toEqual([
      "P03-2:reference",
    ]);
    expect(findings("| P03-2 | x | `a/b.test.ts` | dropped later |")).toEqual(["P03-2:verdict"]);
  });
  it("refuses a duplicate id and a short row", () => {
    expect(findings("| P01-1 | x | `a/b.test.ts` | green |")).toEqual(["P01-1:duplicate"]);
    expect(findings("| P03-2 | x | green |")).toEqual(["P03-2:shape"]);
  });
  it("lets the older models block abbreviate, and a dropped row name no file", () => {
    expect(findings("| P07-9 | x | `b.test.ts` | green (opt-in) |", false)).toEqual([]);
    expect(findings("| P07-9 | x | `c.test.ts` | green |", false)).toEqual(["P07-9:proof"]);
    expect(findings("| P07-9 | x | `b.test.ts`, `mcp.add`, `/mcp` | green |", false)).toEqual([]);
    expect(findings("| P08-3 | x | dropped by owner (M13R20) | dropped (owner m10) |", false)).toEqual([]);
    expect(findings("| P08-3 | x | dropped by owner (M13R20) | dropped (owner m10) |", true)).toEqual([
      "P08-3:proof",
    ]);
  });
});

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOTE = "docs/agents/parity.md";
const MODELS = "docs/agents/models.md";
const PLAN = "docs/plans/2026-10-18-m13-v1-hardening.md";

function walk(dir: string, into: string[]): void {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(path, into);
    else into.push(path);
  }
}
function repoFiles(): string[] {
  const files: string[] = [];
  for (const dir of ["apps", "packages", "scripts"]) walk(dir, files);
  return files;
}
function researchText(): string {
  const dir = join(ROOT, "docs/research");
  const parts = readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .map((n) => readFileSync(join(dir, n), "utf8"));
  if (existsSync(join(ROOT, PLAN))) parts.push(readFileSync(join(ROOT, PLAN), "utf8"));
  return parts.join("\n");
}

function realContext(): Context {
  const files = repoFiles();
  const research = researchText();
  const log = readFileSync(join(ROOT, "docs/research/decisions-log.md"), "utf8");
  return {
    exists: (p) => existsSync(join(ROOT, p)),
    resolveLoose: (token) => {
      const tail = token.includes("...") ? token.slice(token.lastIndexOf("...") + 3) : token;
      const wanted = tail.replace(/^\/+/, "");
      return files.some((f) => f === wanted || f.endsWith(`/${wanted}`));
    },
    hasRuling: (ruling) => new RegExp(`\\b${ruling}\\b`).test(research),
    hasDecision: (n) => new RegExp(`^\\| ${n} \\|`, "m").test(log),
  };
}

describe("docs/agents/parity.md", () => {
  const load = () => ({
    ctx: realContext(),
    own: parseRows(NOTE, readFileSync(join(ROOT, NOTE), "utf8")),
    models: parseRows(MODELS, readFileSync(join(ROOT, MODELS), "utf8")).filter(
      (r) => r.domain >= 7 && r.domain <= 10,
    ),
  });

  it("holds a row for every domain D01 to D22, a proof that exists and a verdict that is not a gap", () => {
    const { ctx, own, models } = load();
    const found = [
      ...checkRows(own, ctx, true).filter((f) => f.rule !== "domain"),
      ...checkRows(models, ctx, false).filter((f) => f.rule !== "domain"),
    ];
    const domains = checkRows([...own, ...models], ctx, true).filter((f) => f.rule === "domain");
    expect([...found, ...domains].map((f) => `${f.row} ${f.rule}: ${f.detail}`)).toEqual([]);
  });

  it("keeps D07 to D10 in models.md and the other domains here, with no id in both", () => {
    const { own, models } = load();
    expect(own.filter((r) => r.domain >= 7 && r.domain <= 10).map((r) => r.id)).toEqual([]);
    expect(models.length).toBeGreaterThanOrEqual(30);
    const ids = new Set(own.map((r) => r.id));
    expect(models.filter((r) => ids.has(r.id))).toEqual([]);
  });

  it("records the owner's decisions of M13: sound green, Undo and the four pi-web details after v1", () => {
    const { own } = load();
    const text = (id: RegExp) => own.filter((r) => id.test(r.behaviour));
    expect(text(/Completion sound:/).map((r) => r.verdict)).toEqual(["green"]);
    for (const [name, what] of [
      ["lane archive Undo", /Lane archive Undo/],
      ["Plannotator", /Plannotator/],
      ["visit digest", /Visit digest/],
      ["dated folder", /Default dated working folder/],
      ["linked directory", /Linked-directory allow-link/],
      ["Inbox digest row", /Inbox digest row/],
    ] as const) {
      const rows = text(what);
      expect(rows.map((r) => `${name}: ${r.verdict.startsWith("after v1")}`)).toEqual([`${name}: true`]);
    }
  });
});

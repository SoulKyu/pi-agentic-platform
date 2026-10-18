import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface AllowEntry {
  note: string;
  rule: "path" | "env" | "method" | "stale";
  token: string;
  reason: string;
  sweep?: "P1a" | "P1b" | "P2a" | "P2b";
}
interface Finding {
  note: string;
  line: number;
  rule: "path" | "env" | "method" | "stale" | "length" | "allow";
  token: string;
}
interface Repo {
  exists(p: string): boolean;
  source: string;
  methods: Set<string>;
  domains: Set<string>;
}

const PATH_ROOTS = /^(apps|packages|scripts|docs|eslint|\.github)\//;
const FILE_EXTENSIONS = new Set([
  "md",
  "ts",
  "tsx",
  "js",
  "mjs",
  "json",
  "sh",
  "yml",
  "yaml",
  "css",
  "html",
  "sql",
  "toml",
]);
const STALE = [
  /Real-host check: pending/i,
  /not yet built/i,
  /to be built/i,
  /\bTODO\b/i,
  /planned for M\d+/i,
  /later milestone/i,
];
const AGENTS_MAX_LINES = 150;

function* backticked(line: string): Generator<string> {
  for (const m of line.matchAll(/`([^`]+)`/g)) yield m[1] as string;
}

function checkLine(note: string, line: number, text: string, repo: Repo): Finding[] {
  const out: Finding[] = [];
  const add = (rule: Finding["rule"], token: string) => out.push({ note, line, rule, token });
  for (const token of backticked(text)) {
    for (const env of token.matchAll(/\bPAP_[A-Z0-9_]*[A-Z0-9]\b/g)) {
      if (!repo.source.includes(env[0])) add("env", env[0]);
    }
    if (/[*<>{}$\s]|\.\.\./.test(token)) continue;
    const path = token.replace(/#.*$/, "").replace(/:\d+(-\d+)?$/, "");
    if (PATH_ROOTS.test(path) && !repo.exists(path)) add("path", path);
    const method = /^([a-z][a-z0-9_]*)\.([A-Za-z_][\w.]*)\(?\)?$/.exec(token);
    const name = token.replace(/\(\)?$/, "");
    const ext = name.slice(name.lastIndexOf(".") + 1);
    if (
      method &&
      repo.domains.has(method[1] as string) &&
      !FILE_EXTENSIONS.has(ext) &&
      !repo.methods.has(name)
    ) {
      add("method", name);
    }
  }
  for (const re of STALE) {
    const hit = re.exec(text);
    if (hit) add("stale", hit[0].toLowerCase());
  }
  return out;
}

function checkNotes(files: Record<string, string>, repo: Repo, allow: AllowEntry[]): Finding[] {
  const found: Finding[] = [];
  for (const [note, text] of Object.entries(files)) {
    const lines = text.split("\n");
    if (note === "AGENTS.md") {
      const count = text.endsWith("\n") ? lines.length - 1 : lines.length;
      if (count > AGENTS_MAX_LINES) found.push({ note, line: count, rule: "length", token: String(count) });
    }
    lines.forEach((text, i) => found.push(...checkLine(note, i + 1, text, repo)));
  }
  const used = new Set<AllowEntry>();
  const open = found.filter((f) => {
    const entry = allow.find((a) => a.note === f.note && a.rule === f.rule && a.token === f.token);
    if (entry) used.add(entry);
    return !entry;
  });
  for (const a of allow)
    if (!used.has(a)) open.push({ note: a.note, line: 0, rule: "allow", token: a.token });
  return open;
}

const repo = (over: Partial<Repo> = {}): Repo => ({
  exists: () => false,
  source: "",
  methods: new Set(["files.read"]),
  domains: new Set(["files"]),
  ...over,
});
const rules = (f: Finding[]) => f.map((x) => `${x.rule}:${x.token}`);

describe("checkNotes", () => {
  it("flags a backticked repository path that does not exist", () => {
    const r = repo({ exists: (p) => p === "apps/daemon/src/main.ts" });
    const files = { "docs/agents/a.md": "see `apps/daemon/src/main.ts` and `apps/daemon/src/gone.ts:12`" };
    expect(rules(checkNotes(files, r, []))).toEqual(["path:apps/daemon/src/gone.ts"]);
  });

  it("skips globs and placeholders", () => {
    const files = { "a.md": "`docs/agents/*.md` `docs/agents/<domain>.md` `apps/{a,b}/x.ts`" };
    expect(checkNotes(files, repo(), [])).toEqual([]);
  });

  it("flags a PAP_ variable absent from source, not a present one", () => {
    const r = repo({ source: "process.env.PAP_HERE" });
    const files = { "a.md": "`PAP_HERE` and `PAP_FOO=1`" };
    expect(rules(checkNotes(files, r, []))).toEqual(["env:PAP_FOO"]);
  });

  it("checks a method only when its domain is a known RPC domain", () => {
    const files = { "a.md": "`files.read` `files.reed` `session.new` `files.md`" };
    expect(rules(checkNotes(files, repo(), []))).toEqual(["method:files.reed"]);
  });

  it("flags the narrow stale-state phrases, case-insensitively, and not bare pending", () => {
    const files = {
      "a.md": [
        "Real-host check: PENDING",
        "Not yet built.",
        "to be built later",
        "TODO fix",
        "planned for M14",
        "a later milestone",
        "pending requests and update_pending",
      ].join("\n"),
    };
    const found = checkNotes(files, repo(), []);
    expect(found.map((f) => f.line)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(found.map((f) => f.rule))).toEqual(new Set(["stale"]));
  });

  it("lets an allow entry through and flags one that matches nothing", () => {
    const files = { "a.md": "`PAP_FOO`" };
    const used: AllowEntry = { note: "a.md", rule: "env", token: "PAP_FOO", reason: "r" };
    const unused: AllowEntry = { note: "a.md", rule: "path", token: "gone/x.ts", reason: "r" };
    expect(checkNotes(files, repo(), [used])).toEqual([]);
    expect(rules(checkNotes(files, repo(), [used, unused]))).toEqual(["allow:gone/x.ts"]);
  });

  it("flags AGENTS.md over 150 lines", () => {
    const long = Array.from({ length: 151 }, () => "x").join("\n");
    expect(rules(checkNotes({ "AGENTS.md": long }, repo(), []))).toEqual(["length:151"]);
    expect(checkNotes({ "AGENTS.md": "x\n".repeat(150) }, repo(), [])).toEqual([]);
  });
});

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_DIRS = ["apps", "packages", "scripts"];
const SOURCE_EXT = /\.(ts|tsx|js|mjs|sh|json|css)$/;
const SELF = /scripts\/docs-truth(\.test\.ts|-allow\.json)$/;

function walk(dir: string, visit: (path: string, rel: string) => void): void {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist" && !entry.name.startsWith("."))
        walk(rel, visit);
    } else if (SOURCE_EXT.test(entry.name)) visit(join(ROOT, rel), rel);
  }
}

function realRepo(): Repo {
  const parts: string[] = [];
  const methods = new Set<string>();
  const named = new Set<string>();
  const keyed: string[] = [];
  for (const dir of SOURCE_DIRS) {
    walk(dir, (path, rel) => {
      if (SELF.test(rel)) return;
      const text = readFileSync(path, "utf8");
      parts.push(text);
      if (!/^packages\/contracts\/src\/[^/]+\.ts$/.test(rel) || rel.endsWith(".test.ts")) return;
      for (const m of text.matchAll(/\bname: "([a-z]+\.[A-Za-z_.]+)"/g)) named.add(m[1] as string);
      for (const m of text.matchAll(/^\s*"([a-z]+\.[A-Za-z_.]+)":/gm)) keyed.push(m[1] as string);
    });
  }
  const domains = new Set([...named].map((n) => n.slice(0, n.indexOf("."))));
  for (const n of [...named, ...keyed]) if (domains.has(n.slice(0, n.indexOf(".")))) methods.add(n);
  return { exists: (p) => existsSync(join(ROOT, p)), source: parts.join("\n"), methods, domains };
}

describe("the notes of this repository", () => {
  it("name only paths, variables and methods that exist, and no stale state", () => {
    const files: Record<string, string> = { "AGENTS.md": readFileSync(join(ROOT, "AGENTS.md"), "utf8") };
    for (const name of readdirSync(join(ROOT, "docs/agents")).filter((n) => n.endsWith(".md"))) {
      files[`docs/agents/${name}`] = readFileSync(join(ROOT, "docs/agents", name), "utf8");
    }
    const allow = JSON.parse(
      readFileSync(join(ROOT, "scripts/docs-truth-allow.json"), "utf8"),
    ) as AllowEntry[];
    const open = checkNotes(files, realRepo(), allow);
    expect(open.map((f) => `${f.note}:${f.line} ${f.rule} ${f.token}`)).toEqual([]);
  });

  it("gives every allow entry a reason", () => {
    const allow = JSON.parse(
      readFileSync(join(ROOT, "scripts/docs-truth-allow.json"), "utf8"),
    ) as AllowEntry[];
    expect(allow.filter((a) => a.reason.trim() === "")).toEqual([]);
  });
});
